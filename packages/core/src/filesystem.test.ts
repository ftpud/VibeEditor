import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
    expect(await fs.read("src/index.ts")).toContain("value = 1");
    await fs.write("src/index.ts", "changed\n");
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toBe("changed\n");
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
