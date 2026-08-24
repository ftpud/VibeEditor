import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatusEntry } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const execFileAsync = promisify(execFile);

export class GitService {
  constructor(private readonly workspace: string) {}

  async status(): Promise<{ branch: string; entries: GitStatusEntry[] }> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.workspace, "status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      });
      return parseGitStatus(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not a git repository")) throw new CoreError("GIT_NOT_REPOSITORY", "Workspace is not a Git repository");
      throw new CoreError("GIT_FAILED", `Could not read Git status: ${message}`);
    }
  }
}

export function parseGitStatus(output: string): { branch: string; entries: GitStatusEntry[] } {
  const records = output.split("\0").filter(Boolean);
  let branch = "HEAD";
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("## ")) {
      branch = record.slice(3).split("...")[0]!.trim();
      continue;
    }
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const entry: GitStatusEntry = { path: record.slice(3), indexStatus, worktreeStatus };
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      entry.originalPath = records[index + 1];
      index += 1;
    }
    entries.push(entry);
  }
  return { branch, entries };
}
