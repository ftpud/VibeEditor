import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService, mapLineRange, parseLineHunks } from "./git.js";
import { watchGitState } from "./git-watch.js";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-git-history-")); directories.push(root);
  const git = (...args: string[]) => run("git", ["-C", root, ...args]).then((result) => result.stdout);
  await git("init", "-q", "-b", "main"); await git("config", "user.email", "t@example.com"); await git("config", "user.name", "Test");
  const write = (name: string, text: string) => writeFile(path.join(root, name), text);
  const commit = async (message: string) => { await git("add", "-A"); await git("commit", "-qm", message); };
  return { root, git, write, commit, service: new GitService(root) };
}
const lines = (count: number, change: Record<number, string> = {}) => Array.from({ length: count }, (_, index) => change[index + 1] ?? `line ${index + 1}`).join("\n") + "\n";

describe("selection history", () => {
  it("returns each commit's own path across renames, so older diffs are not empty", async () => {
    const { write, commit, git, service } = await repository();
    await write("a.txt", lines(20)); await commit("initial");
    await write("a.txt", lines(20, { 15: "line 15 changed" })); await commit("change 15");
    await git("mv", "a.txt", "b.txt"); await commit("rename");
    await write("b.txt", lines(20, { 15: "line 15 again" })); await commit("change 15 again");
    const history = await service.fileHistory("b.txt", 15, 15);
    expect(history.commits.map((item) => [item.subject, item.path])).toEqual([["change 15 again", "b.txt"], ["change 15", "a.txt"], ["initial", "a.txt"]]);
    const file = await service.fileHistory("b.txt");
    expect(file.commits.find((item) => item.subject === "rename")).toMatchObject({ path: "b.txt", originalPath: "a.txt" });
    expect(file.commits.find((item) => item.subject === "change 15")).toMatchObject({ path: "a.txt" });
    expect((await service.commitDiff(history.commits[1]!.hash, history.commits[1]!.path!)).modifiedContent).toContain("line 15 changed");
  });

  it("maps editor lines onto committed lines when the buffer has uncommitted edits", async () => {
    const { write, commit, service } = await repository();
    await write("a.txt", lines(20)); await commit("initial");
    await write("a.txt", lines(20, { 15: "line 15 changed" })); await commit("change 15");
    const buffer = `new 1\nnew 2\nnew 3\n${lines(20, { 15: "line 15 changed" })}`;
    const history = await service.fileHistory("a.txt", 18, 18, buffer);
    expect(history.range).toEqual({ startLine: 15, endLine: 15 });
    expect(history.commits.map((item) => item.subject)).toEqual(["change 15", "initial"]);
    expect(history.note).toContain("committed lines 15-15");
    expect(await service.fileHistory("a.txt", 1, 3, buffer)).toEqual({ commits: [], note: expect.stringContaining("not committed yet") });
    await write("new.txt", "x\n");
    expect((await service.fileHistory("new.txt", 1, 1, "x\n")).note).toContain("no committed history");
  });

  it("maps ranges through additions, deletions and edits", () => {
    // Old 1-2 = new 1-2; new 3-4 added; old 3-9 = new 5-11; old 10-11 became new 12; old 12-19 = new 13-20; old 20 deleted.
    const hunks = parseLineHunks("@@ -2,0 +3,2 @@\n+a\n+b\n@@ -10,2 +12 @@\n-x\n-y\n+z\n@@ -20 +20,0 @@\n-gone\n");
    expect(mapLineRange(hunks, 1, 2)).toEqual({ startLine: 1, endLine: 2 });
    expect(mapLineRange(hunks, 3, 4)).toBeUndefined();
    expect(mapLineRange(hunks, 5, 5)).toEqual({ startLine: 3, endLine: 3 });
    expect(mapLineRange(hunks, 11, 11)).toEqual({ startLine: 9, endLine: 9 });
    expect(mapLineRange(hunks, 12, 12)).toEqual({ startLine: 10, endLine: 11 });
    expect(mapLineRange(hunks, 13, 13)).toEqual({ startLine: 12, endLine: 12 });
    expect(mapLineRange(hunks, 20, 21)).toEqual({ startLine: 19, endLine: 21 });
    expect(mapLineRange(hunks, 2, 5)).toEqual({ startLine: 2, endLine: 3 });
  });
});

describe("Git log pages and ignore", () => {
  it("pages through history without gaps or overlap", async () => {
    const { write, commit, service } = await repository();
    for (let index = 1; index <= 7; index += 1) { await write("a.txt", `${index}\n`); await commit(`commit ${index}`); }
    const first = await service.log("main", 3); const second = await service.log("main", 3, 3); const last = await service.log("main", 3, 6);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
    expect([...first.commits, ...second.commits, ...last.commits].map((item) => item.subject)).toEqual(["commit 7", "commit 6", "commit 5", "commit 4", "commit 3", "commit 2", "commit 1"]);
  });

  it("adds anchored, escaped paths to .gitignore once", async () => {
    const { root, write, service } = await repository();
    await write(".gitignore", "node_modules");
    await service.ignore("build/out #1.log"); await service.ignore("build/out #1.log");
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules\n/build/out\\ \\#1.log\n");
  });
});

it("reports commits and pushes made outside Vibe, batched", async () => {
  const { root, write, commit, git } = await repository();
  await write("a.txt", "1\n"); await commit("initial");
  const changed = vi.fn();
  const watcher = await watchGitState(root, changed, 100);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await write("a.txt", "2\n"); await commit("outside commit");
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 });
    const afterCommit = changed.mock.calls.length;
    expect(afterCommit).toBeLessThanOrEqual(2);
    // A push only moves remote-tracking refs.
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(afterCommit), { timeout: 5000 });
  } finally { await watcher.close(); }
});

it("publishes a branch without an upstream on push and then tracks the same-named remote branch", async () => {
  const { root, write, commit, git, service } = await repository();
  const remote = path.join(root, "..", `${path.basename(root)}-remote.git`); directories.push(remote);
  await run("git", ["init", "-q", "--bare", remote]); await git("remote", "add", "origin", remote);
  await write("a.txt", "1\n"); await commit("initial");
  await git("switch", "-q", "-C", "feature/no-upstream");
  await service.push();
  expect((await git("rev-parse", "--abbrev-ref", "@{upstream}")).trim()).toBe("origin/feature/no-upstream");
  expect((await service.status()).upstream).toMatchObject({ upstream: "origin/feature/no-upstream", ahead: 0, behind: 0 });
});
