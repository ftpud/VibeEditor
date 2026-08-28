import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { GitBranch, GitCommit, GitCommitFile, GitDiffHunk, GitRollbackFailure, GitStatusEntry, GitUpstreamStatus } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);

export class GitService {
  constructor(private readonly workspace: string) {}

  async status(): Promise<{ branch: string; entries: GitStatusEntry[]; upstream?: GitUpstreamStatus }> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.workspace, "status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      });
      const status = parseGitStatus(stdout);
      const upstream = await this.upstreamStatus();
      return { ...status, ...(upstream ? { upstream } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not a git repository")) throw new CoreError("GIT_NOT_REPOSITORY", "Workspace is not a Git repository");
      throw new CoreError("GIT_FAILED", `Could not read Git status: ${message}`);
    }
  }

  private async upstreamStatus(): Promise<GitUpstreamStatus | undefined> {
    try {
      const upstream = (await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
      const ahead = Number((await this.git(["rev-list", "--count", `${upstream}..HEAD`])).trim());
      return upstream && Number.isSafeInteger(ahead) && ahead >= 0 ? { upstream, ahead } : undefined;
    } catch {
      // A detached HEAD or a branch without a configured, resolvable upstream is unpublished.
      return undefined;
    }
  }

  async diff(filePath: string, filesystem: WorkspaceFileSystem): Promise<{ path: string; originalContent: string; modifiedContent: string; hunks: GitDiffHunk[] }> {
    const status = await this.status();
    const entry = status.entries.find((item) => item.path === filePath);
    if (!entry) throw new CoreError("GIT_FAILED", `Path has no Git changes: ${filePath}`);
    const headPath = entry.originalPath ?? entry.path;
    let originalContent = "";
    let modifiedContent = "";
    try {
      const result = await execFileAsync("git", ["-C", this.workspace, "show", `HEAD:${headPath}`], { encoding: "utf8", maxBuffer: 3 * 1024 * 1024 });
      originalContent = result.stdout;
    } catch {
      // New files and repositories without HEAD have no original content.
    }
    try { modifiedContent = await filesystem.read(entry.path); }
    catch (error) {
      if (!(error instanceof CoreError) || error.code !== "FILE_NOT_FOUND") throw error;
    }
    let hunks: GitDiffHunk[] = [];
    if (entry.indexStatus === "?" && entry.worktreeStatus === "?") hunks = modifiedContent ? [{ originalStart: 0, originalLines: 0, modifiedStart: 1, modifiedLines: modifiedContent.split("\n").length - (modifiedContent.endsWith("\n") ? 1 : 0) }] : [];
    else {
      try { hunks = parseDiffHunks(await this.git(["diff", "--unified=0", "HEAD", "--", entry.path])); } catch { /* Repositories without HEAD are treated as new files. */ }
    }
    return { path: entry.path, originalContent, modifiedContent, hunks };
  }

  async branches(): Promise<GitBranch[]> {
    const output = await this.git(["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(HEAD)%00", "refs/heads", "refs/remotes"]);
    return output.split("\n").filter(Boolean).map((line) => { const [ref, name, head] = line.split("\0"); return { name: name!, current: head === "*", remote: ref!.startsWith("refs/remotes/") }; }).filter((item) => !item.name.endsWith("/HEAD"));
  }

  async checkoutBranch(branch: string, remote = false): Promise<string> {
    validateBranchName(branch);
    if (remote) {
      const localName = branch.split("/").slice(1).join("/");
      validateBranchName(localName);
      await this.git(["switch", "--track", "-c", localName, branch]);
    } else await this.git(["switch", branch]);
    return (await this.status()).branch;
  }

  async renameBranch(branch: string, newName: string): Promise<string> {
    validateBranchName(branch); validateBranchName(newName);
    await this.git(["branch", "-m", branch, newName]);
    return (await this.status()).branch;
  }

  async log(branch: string, limit = 200): Promise<GitCommit[]> {
    if (!/^[\w./@{}~^:+-]+$/.test(branch)) throw new CoreError("INVALID_REQUEST", "Invalid Git branch");
    return parseGitGraphLog(await this.git(["log", branch, "--graph", "--date-order", `--max-count=${Math.max(1, Math.min(500, limit))}`, "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%D"]));
  }

  async commitFiles(hash: string): Promise<GitCommitFile[]> {
    validateHash(hash);
    return parseCommitFiles(await this.git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", hash]));
  }

  async commitDiff(hash: string, filePath: string, originalPath?: string): Promise<{ originalContent: string; modifiedContent: string }> {
    validateHash(hash); validatePath(filePath); if (originalPath) validatePath(originalPath);
    const modifiedContent = await this.show(`${hash}:${filePath}`);
    const originalContent = await this.show(`${hash}^:${originalPath ?? filePath}`);
    return { originalContent, modifiedContent };
  }

  async cherryPick(hash: string, commit: boolean): Promise<string> {
    validateHash(hash);
    await this.git(["cherry-pick", ...(commit ? [] : ["--no-commit"]), hash]);
    return (await this.status()).branch;
  }

  async fileHistory(filePath: string, startLine?: number, endLine?: number): Promise<GitCommit[]> {
    validatePath(filePath);
    const lineHistory = startLine !== undefined && endLine !== undefined;
    if (lineHistory && (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine! < 1 || endLine! < startLine!)) throw new CoreError("INVALID_REQUEST", "Invalid history line range");
    const args = lineHistory ? ["log", `-L${startLine},${endLine}:${filePath}`, "--no-patch", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00"] : ["log", "--follow", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00", "--", filePath];
    return parseGitLog(await this.git(args));
  }

  async compareFiles(ref: string, filePath?: string): Promise<GitCommitFile[]> {
    validateRef(ref); if (filePath) validatePath(filePath);
    const compared = parseCommitFiles(await this.git(["diff", "--name-status", "-z", ref, ...(filePath ? ["--", filePath] : [])]));
    const untracked = (await this.status()).entries.filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?" && (!filePath || entry.path === filePath)).map((entry) => ({ path: entry.path, status: "?" }));
    return [...compared, ...untracked.filter((entry) => !compared.some((item) => item.path === entry.path))];
  }

  async compareDiff(ref: string, filePath: string, filesystem: WorkspaceFileSystem, originalPath?: string): Promise<{ originalContent: string; modifiedContent: string }> {
    validateRef(ref); validatePath(filePath); if (originalPath) validatePath(originalPath);
    const originalContent = await this.show(`${ref}:${originalPath ?? filePath}`);
    let modifiedContent = "";
    try { modifiedContent = await filesystem.read(filePath); } catch (error) { if (!(error instanceof CoreError) || error.code !== "FILE_NOT_FOUND") throw error; }
    return { originalContent, modifiedContent };
  }

  async rollback(filePath: string): Promise<void> {
    validatePath(filePath);
    const entry = (await this.status()).entries.find((item) => item.path === filePath);
    if (!entry) throw new CoreError("GIT_FAILED", `Path has no Git changes: ${filePath}`);
    await this.rollbackEntry(entry);
  }

  async rollbackSelected(paths: string[], deleteUntracked: boolean): Promise<{ rolledBack: string[]; failures: GitRollbackFailure[] }> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) throw new CoreError("INVALID_REQUEST", "Select at least one file to rollback");
    const uniquePaths = [...new Set(paths)];
    for (const filePath of uniquePaths) validatePath(filePath);
    const entries = (await this.status()).entries;
    const rolledBack: string[] = [];
    const failures: GitRollbackFailure[] = [];
    for (const filePath of uniquePaths) {
      const entry = entries.find((item) => item.path === filePath);
      if (!entry) { failures.push({ path: filePath, message: "Path no longer has Git changes" }); continue; }
      if (isUntracked(entry) && !deleteUntracked) { failures.push({ path: filePath, message: "Untracked file deletion was not confirmed" }); continue; }
      try { await this.rollbackEntry(entry); rolledBack.push(filePath); }
      catch (error) { failures.push({ path: filePath, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { rolledBack, failures };
  }

  async commit(paths: string[], message: string): Promise<string> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) throw new CoreError("INVALID_REQUEST", "Select at least one file to commit");
    const uniquePaths = [...new Set(paths)];
    for (const filePath of uniquePaths) validatePath(filePath);
    const trimmedMessage = message.trim();
    if (!trimmedMessage || trimmedMessage.length > 10_000) throw new CoreError("INVALID_REQUEST", "Commit message is required");
    const status = await this.status();
    const selected = status.entries.filter((entry) => uniquePaths.includes(entry.path));
    if (selected.length !== uniquePaths.length) throw new CoreError("GIT_FAILED", "One or more selected files no longer have changes");
    const commitPaths = [...new Set(selected.flatMap((entry) => entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]))];
    await this.git(["add", "-A", "--", ...commitPaths]);
    await this.git(["commit", "--only", "-m", trimmedMessage, "--", ...commitPaths]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async push(): Promise<void> {
    await this.git(["push"]);
  }

  async diffStats(): Promise<{ additions: number; deletions: number }> {
    let additions = 0; let deletions = 0;
    try {
      const output = await this.git(["diff", "--numstat", "HEAD"]);
      for (const line of output.split("\n")) { const [added, removed] = line.split("\t"); if (/^\d+$/.test(added ?? "")) additions += Number(added); if (/^\d+$/.test(removed ?? "")) deletions += Number(removed); }
    } catch { /* Repositories without HEAD are represented by untracked files below. */ }
    try {
      const untracked = (await this.git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      for (const file of untracked) { try { const content = await readFile(path.join(this.workspace, file), "utf8"); if (!content.includes("\0")) additions += content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0; } catch { /* Binary and unreadable files do not have line stats. */ } }
    } catch { /* Ignore unavailable untracked stats. */ }
    return { additions, deletions };
  }

  private async git(args: string[]): Promise<string> {
    try { return (await execFileAsync("git", ["-C", this.workspace, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch (error) { throw new CoreError("GIT_FAILED", error instanceof Error ? error.message : String(error)); }
  }

  private async rollbackEntry(entry: GitStatusEntry): Promise<void> {
    if (isUntracked(entry)) { await this.git(["clean", "-f", "--", entry.path]); return; }
    if (entry.indexStatus === "A" && !await this.hasHead()) { await this.git(["rm", "-f", "--", entry.path]); return; }
    const paths = entry.originalPath && (entry.indexStatus === "R" || entry.worktreeStatus === "R") ? [entry.originalPath, entry.path] : [entry.path];
    await this.git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
  }

  private async hasHead(): Promise<boolean> {
    try { await this.git(["rev-parse", "--verify", "HEAD"]); return true; } catch { return false; }
  }

  private async show(spec: string): Promise<string> {
    try { return await this.git(["show", spec]); } catch { return ""; }
  }
}

function isUntracked(entry: GitStatusEntry): boolean { return entry.indexStatus === "?" && entry.worktreeStatus === "?"; }

export function parseDiffHunks(output: string): GitDiffHunk[] {
  return [...output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({ originalStart: Number(match[1]), originalLines: Number(match[2] ?? 1), modifiedStart: Number(match[3]), modifiedLines: Number(match[4] ?? 1) }));
}

function validateHash(hash: string): void { if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new CoreError("INVALID_REQUEST", "Invalid commit hash"); }
function validateRef(ref: string): void { if (!/^[\w./@{}~^:+-]+$/.test(ref)) throw new CoreError("INVALID_REQUEST", "Invalid Git reference"); }
function validateBranchName(name: string): void { if (!name || !/^[\w./-]+$/.test(name) || name.startsWith("-") || name.includes("..") || name.includes("//") || name.endsWith("/")) throw new CoreError("INVALID_REQUEST", "Invalid Git branch name"); }
function validatePath(filePath: string): void { if (!filePath || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) throw new CoreError("INVALID_REQUEST", "Invalid Git path"); }

export function parseGitLog(output: string): GitCommit[] {
  const fields = output.split("\0"); const commits: GitCommit[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const hash = fields[index]!.trim(); if (!/^[0-9a-f]{40,64}$/i.test(hash)) continue;
    commits.push({ hash, shortHash: fields[index + 1]!, author: fields[index + 2]!, date: fields[index + 3]!, subject: fields[index + 4]! });
  }
  return commits;
}

export function parseGitGraphLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  let connectors: string[] = [];
  for (const line of output.split("\n")) {
    const marker = line.indexOf("\x1e");
    if (marker < 0) { if (line.trim()) connectors.push(line); continue; }
    const graphLine = line.slice(0, marker).replace(/\s+$/, "");
    const fields = line.slice(marker + 1).split("\x1f");
    if (!/^[0-9a-f]{40,64}$/i.test(fields[0] ?? "")) { connectors = []; continue; }
    const parents = (fields[5] ?? "").split(" ").filter(Boolean);
    const refs = (fields[6] ?? "").split(", ").map((ref) => ref.replace(/^HEAD -> /, "").trim()).filter(Boolean);
    commits.push({ hash: fields[0]!, shortHash: fields[1] ?? fields[0]!.slice(0, 7), author: fields[2] ?? "", date: fields[3] ?? "", subject: fields[4] ?? "", ...(parents.length ? { parents } : {}), ...(refs.length ? { refs } : {}), graph: [...connectors, graphLine].join("\n") || "*" });
    connectors = [];
  }
  return commits;
}

export function parseCommitFiles(output: string): GitCommitFile[] {
  const fields = output.split("\0").filter(Boolean); const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]!; const firstPath = fields[index + 1]; if (!firstPath) break;
    if (/^[RC]/.test(status)) { const nextPath = fields[index + 2]; if (!nextPath) break; files.push({ status, originalPath: firstPath, path: nextPath }); index += 1; }
    else files.push({ status, path: firstPath });
  }
  return files;
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
