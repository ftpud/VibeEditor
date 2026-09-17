import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_SIZE, WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceFileSystem", () => {
  let root: string;
  let fs: WorkspaceFileSystem;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "remote-ide-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    fs = new WorkspaceFileSystem();
  });

  it("opens an existing workspace and builds its tree", async () => {
    const tree = await fs.open(root);
    expect(tree[0]).toMatchObject({ name: "src", type: "directory" });
    expect(tree[0]?.children?.[0]).toMatchObject({ path: "src/index.ts", type: "file" });
  });

  it("skips git-ignored files unless they are requested", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.open(root);
    const filtered = await fs.listTree();
    expect(filtered.map((node) => node.name)).not.toContain("node_modules");
    expect(filtered.map((node) => node.name)).toEqual(expect.arrayContaining([".gitignore", "src"]));
    const full = await fs.listTree(true);
    expect(full.map((node) => node.name)).toContain("node_modules");
  });

  it("shows an empty, non-ignored directory in a Git workspace", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await fs.open(root);
    await fs.createDirectory("empty");
    expect((await fs.listTree()).some((node) => node.path === "empty" && node.type === "directory")).toBe(true);
  });

  it("rejects a missing workspace", async () => {
    await expect(fs.open(path.join(root, "missing"))).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("reads and writes a file", async () => {
    await fs.open(root);
    const opened = await fs.read("src/index.ts");
    expect(opened.content).toContain("value = 1");
    await fs.write("src/index.ts", "changed\n", opened.revision);
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toBe("changed\n");
  });

  it("rejects stale saves and permits an explicit overwrite", async () => {
    await fs.open(root);
    const opened = await fs.read("src/index.ts");
    await writeFile(path.join(root, "src", "index.ts"), "external\n");
    await expect(fs.write("src/index.ts", "editor\n", opened.revision)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    const saved = await fs.write("src/index.ts", "editor\n", opened.revision, true);
    expect(saved.revision.version).not.toBe(opened.revision.version);
  });

  it("creates files and directories and renames them within the workspace", async () => {
    await fs.open(root);
    await fs.createDirectory("src/components");
    await fs.createFile("src/components/Tree.tsx");
    await fs.rename("src/components/Tree.tsx", "src/components/ProjectTree.tsx");
    await fs.rename("src/components", "src/ui");
    expect(await readFile(path.join(root, "src", "ui", "ProjectTree.tsx"), "utf8")).toBe("");
  });

  it("does not overwrite existing paths when renaming", async () => {
    await fs.open(root);
    await fs.createFile("one.txt");
    await fs.createFile("two.txt");
    await expect(fs.rename("one.txt", "two.txt")).rejects.toMatchObject({ code: "WRITE_FAILED" });
  });

  it("preflights normalized bulk copies and requires explicit collision overwrites", async () => {
    await fs.open(root);
    await mkdir(path.join(root, "target"));
    await writeFile(path.join(root, "target", "index.ts"), "old\n");
    const items = [
      { source: "src", destination: "target/src-copy" },
      { source: "src/index.ts", destination: "target/index.ts" }
    ];
    const preview = await fs.transferPreflight("copy", items, [], ["src/index.ts"], []);
    expect(preview).toMatchObject({ collisions: 0, openFiles: ["src/index.ts"], confirmationRequired: true });
    expect(preview.skipped).toEqual([{ source: "src/index.ts", reason: "Already included by selected directory src" }]);
    const collision = await fs.transferPreflight("copy", [{ source: "src/index.ts", destination: "target/index.ts" }]);
    expect(collision.items[0]).toMatchObject({ collision: true, overwrite: false });
    await expect(fs.transferApply("copy", [{ source: "src/index.ts", destination: "target/index.ts" }], [], [], [], true)).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(await fs.transferApply("copy", [{ source: "src/index.ts", destination: "target/index.ts" }], ["target/index.ts"], [], [], true)).toMatchObject({ failures: [] });
    expect(await readFile(path.join(root, "target", "index.ts"), "utf8")).toContain("value = 1");
  });

  it("moves multiple paths, reports dirty blockers, and supports case-only names", async () => {
    await fs.open(root);
    await fs.createFile("README.md");
    await expect(fs.transferApply("move", [{ source: "README.md", destination: "Readme.md" }], [], ["README.md"], ["README.md"], true)).rejects.toMatchObject({ code: "WRITE_FAILED" });
    const preview = await fs.transferPreflight("move", [{ source: "README.md", destination: "Readme.md" }]);
    expect(preview.items[0]).toMatchObject({ caseOnlyRename: true });
    const result = await fs.transferApply("move", [{ source: "README.md", destination: "Readme.md" }], [], [], [], true);
    expect(result).toEqual({ completed: [{ source: "README.md", destination: "Readme.md" }], failures: [] });
    await expect(access(path.join(root, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "Readme.md"))).resolves.toBeUndefined();
  });

  it("previews, trashes, and restores a directory without exposing trash in the tree", async () => {
    await fs.open(root);
    const preview = await fs.previewDelete("src");
    expect(preview).toMatchObject({ path: "src", type: "directory", childCount: 1, children: ["src/index.ts"], recoverable: true });
    const deleted = await fs.delete("src");
    expect(deleted.permanentlyDeleted).toBe(false);
    await expect(access(path.join(root, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.listTree(true)).some((node) => node.name === ".vibe-trash")).toBe(false);
    expect(await fs.restore(deleted.recoveryId!)).toBe("src");
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("value = 1");
  });

  it("supports explicit permanent delete and rejects the workspace trash namespace", async () => {
    await fs.open(root);
    expect(await fs.delete("src/index.ts", true)).toEqual({ path: "src/index.ts", permanentlyDeleted: true });
    await expect(access(path.join(root, "src", "index.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.createFile(".vibe-trash/nope")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("blocks parent traversal", async () => {
    await fs.open(root);
    await expect(fs.read("../secret.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("blocks absolute paths", async () => {
    await fs.open(root);
    await expect(fs.read(path.join(root, "src/index.ts"))).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("blocks symlinks that leave the workspace", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "remote-ide-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await fs.open(root);
    await expect(fs.read("link.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects files over the size limit", async () => {
    await writeFile(path.join(root, "large.txt"), Buffer.alloc(MAX_FILE_SIZE + 1, 65));
    await fs.open(root);
    await expect(fs.read("large.txt")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
