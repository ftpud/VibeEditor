import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService, parseCommitFiles, parseGitLog, parseGitStatus } from "./git.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);

describe("parseGitStatus", () => {
  it("parses branch and changed file states", () => {
    const result = parseGitStatus("## main...origin/main\0 M src/app.ts\0A  src/new.ts\0?? notes.txt\0");
    expect(result.branch).toBe("main");
    expect(result.entries).toEqual([
      { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" },
      { path: "src/new.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "notes.txt", indexStatus: "?", worktreeStatus: "?" }
    ]);
  });

  it("parses null-delimited rename records", () => {
    expect(parseGitStatus("## main\0R  src/new.ts\0src/old.ts\0").entries[0]).toEqual({
      path: "src/new.ts", originalPath: "src/old.ts", indexStatus: "R", worktreeStatus: " "
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
    await expect(new GitService(root).diff("file.txt", filesystem)).resolves.toEqual({ path: "file.txt", originalContent: "original\n", modifiedContent: "modified\n", hunks: [{ originalStart: 1, originalLines: 1, modifiedStart: 1, modifiedLines: 1 }] });
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
});
