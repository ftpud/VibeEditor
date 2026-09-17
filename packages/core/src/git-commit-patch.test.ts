import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService } from "./git.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "commit-patch-test-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout;
  await git("init"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com");
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
  await writeFile(path.join(root, "file.txt"), original);
  await git("add", "."); await git("commit", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).trim();
  await git("switch", "-c", "source");
  await writeFile(path.join(root, "file.txt"), original.replace("line 2\n", "first change\n").replace("line 25\n", "second change\n"));
  await git("add", "."); await git("commit", "-m", "two changes");
  const hash = (await git("rev-parse", "HEAD")).trim();
  await git("switch", "-c", "target", base);
  return { root, git, original, base, hash, service: new GitService(root) };
}
describe("selected commit changes", () => {
  it("applies only selected parent-to-commit hunks to the index, preserving staged and working edits", async () => {
    const { root, git, original, base, hash, service } = await fixture();
    await writeFile(path.join(root, "unrelated.txt"), "already staged\n"); await git("add", "unrelated.txt");
    await writeFile(path.join(root, "file.txt"), "unstaged local work\n" + original);
    const preview = await service.commitPatch(hash);
    expect(preview.files[0]!.hunks).toHaveLength(2);
    expect(preview.files[0]!.hunks[0]!.content).toContain("+first change");
    await service.applyCommitHunks(preview.hash, preview.indexVersion, [preview.files[0]!.hunks[0]!.id]);
    expect(await git("show", ":file.txt")).toBe(original.replace("line 2\n", "first change\n"));
    expect(await git("show", ":unrelated.txt")).toBe("already staged\n");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("unstaged local work\n" + original);
    expect((await git("rev-parse", "HEAD")).trim()).toBe(base);
  });
  it("combines multiple selected hunks for a file and rejects stale selections", async () => {
    const { git, original, hash, service } = await fixture();
    const preview = await service.commitPatch(hash);
    const ids = preview.files[0]!.hunks.map((hunk) => hunk.id);
    expect(await service.applyCommitHunks(hash, preview.indexVersion, ids)).toEqual({ applied: 2 });
    expect(await git("show", ":file.txt")).toBe(original.replace("line 2\n", "first change\n").replace("line 25\n", "second change\n"));
    await expect(service.applyCommitHunks(hash, preview.indexVersion, ids)).rejects.toThrow("index changed");
    await expect(service.applyCommitHunks(hash, preview.indexVersion, ["f".repeat(64)])).rejects.toThrow("do not belong");
  });
  it("leaves the index unchanged when any selected hunk conflicts", async () => {
    const { root, git, original, hash, service } = await fixture();
    await writeFile(path.join(root, "file.txt"), original.replace("line 25\n", "different staged change\n"));
    await git("add", "file.txt");
    const before = await git("show", ":file.txt");
    const preview = await service.commitPatch(hash);
    await expect(service.applyCommitHunks(hash, preview.indexVersion, preview.files[0]!.hunks.map((hunk) => hunk.id))).rejects.toThrow("No selected changes were applied");
    expect(await git("show", ":file.txt")).toBe(before);
  });
  it("supports root commit text additions", async () => {
    const { git, base, service } = await fixture();
    await git("switch", "--orphan", "empty");
    const preview = await service.commitPatch(base);
    expect(preview.files[0]!.hunks).toHaveLength(1);
    await service.applyCommitHunks(base, preview.indexVersion, [preview.files[0]!.hunks[0]!.id]);
    expect(await git("show", ":file.txt")).toContain("line 1\n");
  });
});

describe("editable commit results", () => {
  it("applies reviewed results to local files without changing the index", async () => {
    const { root, git, original, hash, service } = await fixture();
    await writeFile(path.join(root, "unrelated.txt"), "staged\n"); await git("add", "unrelated.txt");
    const filesystem = new WorkspaceFileSystem(); await filesystem.open(root);
    const current = await filesystem.read("file.txt");
    await service.saveCommitWorktreeResults(hash, [{ path: "file.txt", content: "local applied result\n", expectedRevision: current.revision }], filesystem);
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("local applied result\n");
    expect(await git("show", ":file.txt")).toBe(original);
    expect(await git("show", ":unrelated.txt")).toBe("staged\n");
    expect(await git("diff", "--cached", "--", "file.txt")).toBe("");
    expect(await git("diff", "--", "file.txt")).toContain("+local applied result");
  });
  it("rejects a local file changed after preview and leaves it untouched", async () => {
    const { root, hash, service } = await fixture();
    const filesystem = new WorkspaceFileSystem(); await filesystem.open(root);
    const current = await filesystem.read("file.txt");
    await writeFile(path.join(root, "file.txt"), "newer local edit\n");
    await expect(service.saveCommitWorktreeResults(hash, [{ path: "file.txt", content: "stale result\n", expectedRevision: current.revision }], filesystem)).rejects.toThrow("changed after preview");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("newer local edit\n");
  });
  it("saves manual results while preserving working files and unrelated staged changes", async () => {
    const { root, git, original, hash, service } = await fixture();
    await writeFile(path.join(root, "unrelated.txt"), "staged\n"); await git("add", "unrelated.txt");
    const preview = await service.commitPatch(hash);
    expect(preview.files[0]!.indexContent).toBe(original);
    await service.saveCommitResults(hash, preview.indexVersion, [{ path: "file.txt", content: "manual result without newline" }]);
    expect(await git("show", ":file.txt")).toBe("manual result without newline");
    expect(await git("show", ":unrelated.txt")).toBe("staged\n");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(original);
    await expect(service.saveCommitResults(hash, preview.indexVersion, [{ path: "file.txt", content: "stale" }])).rejects.toThrow("index changed");
  });
  it("creates added files from an editable root-commit result", async () => {
    const { git, base, service } = await fixture();
    await git("switch", "--orphan", "result-empty");
    const preview = await service.commitPatch(base);
    expect(preview.files[0]!.indexContent).toBe("");
    await service.saveCommitResults(base, preview.indexVersion, [{ path: "file.txt", content: "new draft\n" }]);
    expect(await git("show", ":file.txt")).toBe("new draft\n");
  });
  it("rejects files outside the commit without changing the index", async () => {
    const { git, original, hash, service } = await fixture();
    const preview = await service.commitPatch(hash);
    await expect(service.saveCommitResults(hash, preview.indexVersion, [{ path: "file.txt", content: "edit" }, { path: "other.txt", content: "no" }])).rejects.toThrow("Invalid text result");
    expect(await git("show", ":file.txt")).toBe(original);
  });
  it("supports explicit deletion and keeps an empty edited file", async () => {
    const { git, hash, service } = await fixture();
    let preview = await service.commitPatch(hash);
    await service.saveCommitResults(hash, preview.indexVersion, [{ path: "file.txt", content: "" }]);
    expect(await git("show", ":file.txt")).toBe("");
    preview = await service.commitPatch(hash);
    await service.saveCommitResults(hash, preview.indexVersion, [{ path: "file.txt", content: null }]);
    expect(await git("ls-files")).toBe("");
  });
});
