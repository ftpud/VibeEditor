import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService } from "./git.js";

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
