import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService, parseCommitFiles, parseGitGraphLog, parseGitLog, parseGitStatus, validateTagName } from "./git.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);

describe("parseGitStatus", () => {
  it("parses branch and changed file states", () => {
    const result = parseGitStatus("## main...origin/main\0 M src/app.ts\0A  src/new.ts\0?? notes.txt\0");
    expect(result.branch).toBe("main");
    expect(result.entries).toEqual([
      { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M", states: ["worktree"] },
      { path: "src/new.ts", indexStatus: "A", worktreeStatus: " ", states: ["index"] },
      { path: "notes.txt", indexStatus: "?", worktreeStatus: "?", states: ["untracked"] }
    ]);
  });

  it("parses null-delimited rename records", () => {
    expect(parseGitStatus("## main\0R  src/new.ts\0src/old.ts\0").entries[0]).toEqual({
      path: "src/new.ts", originalPath: "src/old.ts", indexStatus: "R", worktreeStatus: " ", states: ["index"]
    });
  });

  it("returns HEAD and workspace contents for a changed file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "original\n");
    await execFileAsync("git", ["-C", root, "add", "file.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "file.txt"), "modified\n");
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);
    const service = new GitService(root);
    await expect(service.diff("file.txt", filesystem)).resolves.toMatchObject({ path: "file.txt", originalContent: "original\n", modifiedContent: "modified\n", hunks: [{ originalStart: 1, originalLines: 1, modifiedStart: 1, modifiedLines: 1, source: "worktree", patch: expect.any(String), version: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    await writeFile(path.join(root, "new.txt"), "one\ntwo\n");
    await expect(service.diffStats()).resolves.toEqual({ additions: 3, deletions: 1 });
  });

  it("rolls back tracked and untracked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rollback-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "tracked.txt"), "original\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    const service = new GitService(root);
    await service.rollback("tracked.txt");
    await service.rollback("new.txt");
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("original\n");
    await expect(access(path.join(root, "new.txt"))).rejects.toThrow();
  });

  it("stages and unstages exact reviewed hunks without changing the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-hunks-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "one\ntwo\nthree\n");
    await execFileAsync("git", ["-C", root, "add", "file.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "file.txt"), "ONE\ntwo\nTHREE\n");
    const filesystem = new WorkspaceFileSystem(); await filesystem.open(root);
    const service = new GitService(root);
    const reviewed = await service.diff("file.txt", filesystem);
    expect(reviewed.hunks).toHaveLength(2);
    await service.stage("file.txt", reviewed.hunks[0]);
    expect((await execFileAsync("git", ["-C", root, "diff", "--cached"])).stdout).toContain("ONE");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
    const staged = await service.diff("file.txt", filesystem);
    const stagedHunk = staged.hunks.find((hunk) => hunk.source === "index")!;
    await service.unstage("file.txt", stagedHunk);
    expect((await execFileAsync("git", ["-C", root, "diff", "--cached"])).stdout).toBe("");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("rejects a stale reviewed hunk with a refresh instruction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-stale-hunk-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await writeFile(path.join(root, "file.txt"), "before\n"); await execFileAsync("git", ["-C", root, "add", "file.txt"]); await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(path.join(root, "file.txt"), "first\n"); const filesystem = new WorkspaceFileSystem(); await filesystem.open(root); const service = new GitService(root);
    const hunk = (await service.diff("file.txt", filesystem)).hunks[0]!;
    await writeFile(path.join(root, "file.txt"), "second\n");
    await expect(service.stage("file.txt", hunk)).rejects.toThrow("Refresh the diff and try again");
  });

  it("rolls back only selected staged, unstaged, partially staged, deleted, and renamed entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rollback-selected-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    for (const file of ["staged.txt", "unstaged.txt", "partial.txt", "deleted.txt", "old.txt", "untouched.txt"]) await writeFile(path.join(root, file), `${file} original\n`);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "staged.txt"), "staged change\n");
    await execFileAsync("git", ["-C", root, "add", "staged.txt"]);
    await writeFile(path.join(root, "unstaged.txt"), "unstaged change\n");
    await writeFile(path.join(root, "partial.txt"), "staged portion\n");
    await execFileAsync("git", ["-C", root, "add", "partial.txt"]);
    await writeFile(path.join(root, "partial.txt"), "worktree portion\n");
    await execFileAsync("git", ["-C", root, "rm", "deleted.txt"]);
    await execFileAsync("git", ["-C", root, "mv", "old.txt", "renamed.txt"]);
    await writeFile(path.join(root, "untouched.txt"), "keep this change\n");

    const service = new GitService(root);
    const result = await service.rollbackSelected(["staged.txt", "unstaged.txt", "partial.txt", "deleted.txt", "renamed.txt"], false);

    expect(result).toEqual({ rolledBack: ["staged.txt", "unstaged.txt", "partial.txt", "deleted.txt", "renamed.txt"], failures: [] });
    for (const file of ["staged.txt", "unstaged.txt", "partial.txt", "deleted.txt", "old.txt"]) expect(await readFile(path.join(root, file), "utf8")).toBe(`${file} original\n`);
    await expect(access(path.join(root, "renamed.txt"))).rejects.toThrow();
    expect((await service.status()).entries.map((entry) => entry.path)).toEqual(["untouched.txt"]);
  });

  it("requires explicit permission before deleting selected untracked files and reports partial failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rollback-untracked-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "tracked.txt"), "original\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    await writeFile(path.join(root, "untracked.txt"), "do not delete silently\n");
    const service = new GitService(root);

    await expect(service.rollbackSelected(["tracked.txt", "untracked.txt", "missing.txt"], false)).resolves.toEqual({
      rolledBack: ["tracked.txt"],
      failures: [
        { path: "untracked.txt", message: "Untracked file deletion was not confirmed" },
        { path: "missing.txt", message: "Path no longer has Git changes" }
      ]
    });
    expect(await readFile(path.join(root, "untracked.txt"), "utf8")).toBe("do not delete silently\n");
    await expect(service.rollbackSelected(["untracked.txt"], true)).resolves.toEqual({ rolledBack: ["untracked.txt"], failures: [] });
    await expect(access(path.join(root, "untracked.txt"))).rejects.toThrow();
  });

  it("rolls back a staged new file in a repository without HEAD", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rollback-unborn-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await writeFile(path.join(root, "new.txt"), "new\n");
    await execFileAsync("git", ["-C", root, "add", "new.txt"]);
    const service = new GitService(root);
    await expect(service.rollbackSelected(["new.txt"], false)).resolves.toEqual({ rolledBack: ["new.txt"], failures: [] });
    await expect(access(path.join(root, "new.txt"))).rejects.toThrow();
    expect((await service.status()).entries).toEqual([]);
  });

  it("rolls back a selected merge conflict to HEAD", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rollback-conflict-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "conflict.txt"), "base\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
    const defaultBranch = (await execFileAsync("git", ["-C", root, "branch", "--show-current"])).stdout.trim();
    await execFileAsync("git", ["-C", root, "switch", "-c", "other"]);
    await writeFile(path.join(root, "conflict.txt"), "other\n");
    await execFileAsync("git", ["-C", root, "commit", "-am", "other"]);
    await execFileAsync("git", ["-C", root, "switch", defaultBranch]);
    await writeFile(path.join(root, "conflict.txt"), "head\n");
    await execFileAsync("git", ["-C", root, "commit", "-am", "head"]);
    await expect(execFileAsync("git", ["-C", root, "merge", "other"])).rejects.toThrow();

    const service = new GitService(root);
    await expect(service.rollbackSelected(["conflict.txt"], false)).resolves.toEqual({ rolledBack: ["conflict.txt"], failures: [] });
    expect(await readFile(path.join(root, "conflict.txt"), "utf8")).toBe("head\n");
    expect((await service.status()).entries).toEqual([]);
  });

  it("commits only selected files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-commit-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "selected.txt"), "before\n");
    await writeFile(path.join(root, "other.txt"), "before\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "selected.txt"), "selected change\n");
    await writeFile(path.join(root, "other.txt"), "other change\n");
    const service = new GitService(root);
    await expect(service.commit(["selected.txt"], "selected commit")).resolves.toMatch(/^[0-9a-f]{40}$/);
    expect((await service.status()).entries.map((entry) => entry.path)).toEqual(["other.txt"]);
    expect((await execFileAsync("git", ["-C", root, "show", "HEAD:selected.txt"])).stdout).toBe("selected change\n");
    expect((await execFileAsync("git", ["-C", root, "show", "HEAD:other.txt"])).stdout).toBe("before\n");
  });

  it("amends only staged index changes and undoes the last commit into the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-rewrite-"));
    await execFileAsync("git", ["-C", root, "init"]); await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]); await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "base\n"); await execFileAsync("git", ["-C", root, "add", "."]); await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(path.join(root, "file.txt"), "staged\n"); await execFileAsync("git", ["-C", root, "add", "file.txt"]); await writeFile(path.join(root, "other.txt"), "unstaged\n");
    const service = new GitService(root);
    expect((await service.historyRewritePreview()).confirmationRequired).toBe(true);
    await expect(service.amend(false)).rejects.toThrow("publication state is unknown");
    await service.amend(true);
    expect((await execFileAsync("git", ["-C", root, "show", "HEAD:file.txt"])).stdout).toBe("staged\n");
    await writeFile(path.join(root, "child.txt"), "child\n"); await execFileAsync("git", ["-C", root, "add", "child.txt"]); await execFileAsync("git", ["-C", root, "commit", "-m", "child"]);
    const undone = await service.undoLastCommit(true);
    expect(undone).toMatch(/^[0-9a-f]{40}$/);
    expect((await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout).toContain("?? child.txt");
    expect((await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout).toContain("?? other.txt");
    const rootPreview = await service.historyRewritePreview();
    expect(rootPreview).toMatchObject({ canUndo: false, undoUnavailableReason: "The root commit cannot be undone safely from this interface." });
    await expect(service.undoLastCommit(true)).rejects.toThrow("root commit cannot be undone safely");
    expect((await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(rootPreview.commit.hash);
  });

  it("cherry-picks a commit or applies it without committing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-cherry-pick-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    const base = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", root, "switch", "-c", "source"]);
    await writeFile(path.join(root, "picked.txt"), "picked\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "pick me"]);
    const picked = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", root, "switch", "-c", "target", base]);
    const service = new GitService(root);
    await expect(service.cherryPick(picked, false)).resolves.toBe("target");
    expect((await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(base);
    expect((await service.status()).entries.map((entry) => entry.path)).toContain("picked.txt");
    await execFileAsync("git", ["-C", root, "reset", "--hard", base]);
    await expect(service.cherryPick(picked, true)).resolves.toBe("target");
    expect((await execFileAsync("git", ["-C", root, "show", "HEAD:picked.txt"])).stdout).toBe("picked\n");
  });
});

describe("Git upstream status", () => {
  it("reports no upstream, ahead/behind counts, fetch time, and clears ahead after push", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "remote-ide-git-upstream-"));
    const remote = path.join(parent, "remote.git");
    const root = path.join(parent, "repo");
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["clone", remote, root]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "initial\n");
    await execFileAsync("git", ["-C", root, "add", "file.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    const service = new GitService(root);
    expect((await service.status()).upstream).toBeUndefined();
    await execFileAsync("git", ["-C", root, "push", "-u", "origin", "HEAD"]);
    const branch = (await execFileAsync("git", ["-C", root, "branch", "--show-current"])).stdout.trim();
    expect((await service.status()).upstream).toMatchObject({ upstream: `origin/${branch}`, ahead: 0, behind: 0 });
    await writeFile(path.join(root, "file.txt"), "next\n");
    await execFileAsync("git", ["-C", root, "commit", "-am", "next"]);
    expect((await service.status()).upstream).toMatchObject({ ahead: 1, behind: 0 });
    await service.push();
    expect((await service.status()).upstream).toMatchObject({ ahead: 0, behind: 0 });

    const other = path.join(parent, "other");
    await execFileAsync("git", ["clone", remote, other]);
    await execFileAsync("git", ["-C", other, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", other, "config", "user.name", "Test"]);
    await writeFile(path.join(other, "remote.txt"), "remote\n");
    await execFileAsync("git", ["-C", other, "add", "remote.txt"]);
    await execFileAsync("git", ["-C", other, "commit", "-m", "remote"]);
    await execFileAsync("git", ["-C", other, "push"]);
    expect((await service.status()).upstream).toMatchObject({ behind: 0 });
    const fetched = await service.fetch();
    expect(fetched.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await service.status()).upstream).toMatchObject({ ahead: 0, behind: 1, lastFetch: fetched.fetchedAt });
  });
});

describe("local Git tags", () => {
  it("lists, creates, and deletes local tags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-tags-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "initial\n");
    await execFileAsync("git", ["-C", root, "add", "file.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    const service = new GitService(root);
    const target = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await expect(service.createTag("v1.0.0", target)).resolves.toEqual({ name: "v1.0.0", target, annotated: false });
    expect(await service.tags()).toEqual([{ name: "v1.0.0", target, annotated: false }]);
    await service.deleteTag("v1.0.0");
    expect(await service.tags()).toEqual([]);
  });

  it("refuses ambiguous or unsafe local tag names", () => {
    for (const name of ["refs/tags/v1", "HEAD", "@", "v1..0", "release^{commit}", "release~1", "-option", "v1.lock", "v1/"]) expect(() => validateTagName(name)).toThrow("Invalid or ambiguous local tag name");
    expect(() => validateTagName("releases/v1.0.0")).not.toThrow();
  });
});

describe("Git branch management", () => {
  it("creates branches, previews unmerged commits, and protects worktree branches from deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-git-branches-"));
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "file.txt"), "initial\n");
    await execFileAsync("git", ["-C", root, "add", "file.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    const service = new GitService(root);
    await expect(service.createBranch("feature/preview")).resolves.toBe("feature/preview");
    await execFileAsync("git", ["-C", root, "worktree", "add", path.join(root, "task-worktree"), "feature/preview"]);
    await expect(service.deleteBranch("feature/preview", false, true, true)).rejects.toThrow("checked out");
    await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", path.join(root, "task-worktree")]);
    await execFileAsync("git", ["-C", root, "switch", "feature/preview"]);
    await writeFile(path.join(root, "file.txt"), "feature\n");
    await execFileAsync("git", ["-C", root, "commit", "-am", "feature"]);
    await execFileAsync("git", ["-C", root, "switch", "-"]);
    const preview = await service.branchDeletePreview("feature/preview", false);
    expect(preview).toMatchObject({ remote: false, confirmationRequired: true, unmerged: [{ subject: "feature" }] });
    await expect(service.deleteBranch("feature/preview", false, false, false)).rejects.toThrow("Confirm deletion");
    await expect(service.deleteBranch("feature/preview", false, true, true)).resolves.toBeUndefined();
  });
});

describe("Git history parsing", () => {
  it("parses null-delimited commit metadata", () => {
    const hash = "a".repeat(40);
    expect(parseGitLog([hash, "abc1234", "Ada", "2026-08-25T00:00:00Z", "Initial commit", "\n"].join("\0"))).toEqual([{ hash, shortHash: "abc1234", author: "Ada", date: "2026-08-25T00:00:00Z", subject: "Initial commit" }]);
  });

  it("parses changed files including renames", () => {
    expect(parseCommitFiles("M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "R100", originalPath: "src/old.ts", path: "src/new.ts" }
    ]);
  });

  it("preserves graph connectors, parents, and branch decorations", () => {
    const first = "a".repeat(40); const second = "b".repeat(40); const parent = "c".repeat(40);
    const output = `* \u001e${first}\u001ffirst\u001fAda\u001f2026-08-25T00:00:00Z\u001fMerge feature\u001f${second} ${parent}\u001fHEAD -> main\n|\\\n| * \u001e${second}\u001fsecond\u001fAda\u001f2026-08-24T00:00:00Z\u001fFeature\u001f${parent}\u001ffeature/test\n`;
    expect(parseGitGraphLog(output)).toEqual([
      { hash: first, shortHash: "first", author: "Ada", date: "2026-08-25T00:00:00Z", subject: "Merge feature", parents: [second, parent], refs: ["main"], graph: "*" },
      { hash: second, shortHash: "second", author: "Ada", date: "2026-08-24T00:00:00Z", subject: "Feature", parents: [parent], refs: ["feature/test"], graph: "|\\\n| *" }
    ]);
  });
});
