import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService, parseGitStatus } from "./git.js";
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
    await expect(new GitService(root).diff("file.txt", filesystem)).resolves.toEqual({ path: "file.txt", originalContent: "original\n", modifiedContent: "modified\n" });
  });
});
