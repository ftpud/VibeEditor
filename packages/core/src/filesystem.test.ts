import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("rejects nonboolean transfer confirmation before preflight or destructive changes", async () => {
    await fs.open(root);
    await writeFile(path.join(root, "source.txt"), "source contents\n");
    await writeFile(path.join(root, "destination.txt"), "destination contents\n");
    const preflight = vi.spyOn(fs, "transferPreflight");

    await expect(fs.transferApply("move", [{ source: "source.txt", destination: "destination.txt" }], ["destination.txt"], [], [], "false" as unknown as boolean))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(preflight).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "source.txt"), "utf8")).resolves.toBe("source contents\n");
    await expect(readFile(path.join(root, "destination.txt"), "utf8")).resolves.toBe("destination contents\n");
  });

  it("moves multiple paths, reports dirty blockers, and supports case-only names", async () => {
    await fs.open(root);
    await fs.createFile("README.md");
    await expect(fs.transferApply("move", [{ source: "README.md", destination: "Readme.md" }], [], ["README.md"], ["README.md"], true)).rejects.toMatchObject({ code: "WRITE_FAILED" });
    const preview = await fs.transferPreflight("move", [{ source: "README.md", destination: "Readme.md" }]);
    expect(preview.items[0]).toMatchObject({ caseOnlyRename: true });
    const result = await fs.transferApply("move", [{ source: "README.md", destination: "Readme.md" }], [], [], [], true);
    expect(result).toEqual({ completed: [{ source: "README.md", destination: "Readme.md" }], failures: [] });
    const names = await readdir(root);
    expect(names).toContain("Readme.md");
    expect(names).not.toContain("README.md");
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

describe("workspace tree producer limits", () => {
  it.each([false, true])("allows trees beyond the former default path and Git output limits (Git=%s)", async (git) => {
    const root = await mkdtemp(path.join(tmpdir(), "tree-unlimited-"));
    try {
      if (git) await execFileAsync("git", ["-C", root, "init", "-q"]);
      // Bound open files while avoiding thousands of serial APFS round trips.
      for (let start = 0; start < 5200; start += 64) {
        await Promise.all(Array.from({ length: Math.min(64, 5200 - start) }, (_, offset) => writeFile(path.join(root, `${start + offset}${"x".repeat(220)}`), "x")));
      }
      expect(await new WorkspaceFileSystem().open(root)).toHaveLength(5200);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
  }, 15_000);

  it("honors configured environment limits while leaving other limits unlimited", async () => {
    vi.stubEnv("VIBE_TREE_MAX_NODES", "1");
    try {
      const root = await mkdtemp(path.join(tmpdir(), "tree-env-limit-"));
      await writeFile(path.join(root, "é".repeat(100)), "x");
      const filesystem = new WorkspaceFileSystem();
      expect(await filesystem.open(root)).toHaveLength(1);
      await writeFile(path.join(root, "extra"), "x");
      await expect(filesystem.listTree()).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])("checks exact aggregate boundaries and rejects without changing files (Git=%s)", async (git) => {
    const root = await mkdtemp(path.join(tmpdir(), "tree-limits-"));
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "dir", "file"), "unchanged");
    if (git) await execFileAsync("git", ["-C", root, "init", "-q"]);
    const exact = new WorkspaceFileSystem({ maxNodes: 2, maxPathBytes: 11, maxDepth: 2 });
    expect((await exact.open(root))[0]?.children?.[0]?.path).toBe("dir/file");
    for (const limits of [{ maxNodes: 1 }, { maxPathBytes: 10 }, { maxDepth: 1 }]) {
      await expect(new WorkspaceFileSystem(limits).open(root)).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
    }
    await writeFile(path.join(root, "extra"), "extra");
    await expect(exact.listTree()).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
    expect((await exact.read("dir/file")).content).toBe("unchanged");
  });

  it.each([false, true])("bounds deep paths and UTF-8 long names (Git=%s)", async (git) => {
    const root = await mkdtemp(path.join(tmpdir(), "tree-depth-"));
    if (git) await execFileAsync("git", ["-C", root, "init", "-q"]);
    await mkdir(path.join(root, "a/b/c/d"), { recursive: true });
    await writeFile(path.join(root, "a/b/c/d", "é".repeat(100)), "x");
    await expect(new WorkspaceFileSystem({ maxDepth: 3 }).open(root)).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
    await expect(new WorkspaceFileSystem({ maxPathBytes: 100 }).open(root)).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
  });

  it("rejects bounded Git stdout rather than falling back to the walk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tree-git-output-"));
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    for (let i = 0; i < 30; i++) await writeFile(path.join(root, `${i}${"x".repeat(200)}`), "x");
    await expect(new WorkspaceFileSystem({ maxNodes: 1, maxPathBytes: 1 }).open(root)).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE", message: expect.stringContaining("Git output") });
  });

  it("applies limits after Git ignore filtering and to includeIgnored traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tree-ignore-limits-"));
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(path.join(root, ".gitignore"), "generated/\n");
    await mkdir(path.join(root, "generated"));
    for (let i = 0; i < 20; i++) await writeFile(path.join(root, "generated", String(i)), "x");
    const filesystem = new WorkspaceFileSystem({ maxNodes: 1 });
    expect(await filesystem.open(root)).toEqual([{ name: ".gitignore", path: ".gitignore", type: "file" }]);
    await expect(filesystem.listTree(true)).rejects.toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE" });
    expect(await filesystem.listTree()).toHaveLength(1);
  });

  it("validates limits", () => {
    for (const maxNodes of [0, -1, NaN, 1.5, Infinity]) expect(() => new WorkspaceFileSystem({ maxNodes })).toThrow("positive safe integer");
  });
});
