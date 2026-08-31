import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { GitBranch, GitBranchDeletePreview, GitCommit, GitCommitFile, GitDiffHunk, GitHistoryRewritePreview, GitRollbackFailure, GitStatusEntry, GitTag, GitUpstreamStatus } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);

export class GitService {
  private static readonly fetches = new Map<string, { controller?: AbortController; lastSuccessful?: string }>();
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
      const [aheadOutput = "", behindOutput = ""] = await Promise.all([
        this.git(["rev-list", "--count", `${upstream}..HEAD`]),
        this.git(["rev-list", "--count", `HEAD..${upstream}`])
      ]);
      const ahead = Number(aheadOutput.trim());
      const behind = Number(behindOutput.trim());
      const lastFetch = GitService.fetches.get(this.workspace)?.lastSuccessful;
      return upstream && Number.isSafeInteger(ahead) && ahead >= 0 && Number.isSafeInteger(behind) && behind >= 0
        ? { upstream, ahead, behind, ...(lastFetch ? { lastFetch } : {}) }
        : undefined;
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
    if (isUntracked(entry)) {
      const patch = await this.untrackedPatch(entry.path);
      hunks = parseDiffHunks(patch, "worktree");
    } else {
      const [indexPatch, worktreePatch] = await Promise.all([
        this.git(["diff", "--cached", "--unified=0", "--", entry.path]).catch(() => ""),
        this.git(["diff", "--unified=0", "--", entry.path]).catch(() => "")
      ]);
      hunks = [...parseDiffHunks(indexPatch, "index"), ...parseDiffHunks(worktreePatch, "worktree")];
    }
    return { path: entry.path, originalContent, modifiedContent, hunks };
  }

  async stage(filePath: string, hunk?: GitDiffHunk): Promise<void> { await this.updateIndex("stage", filePath, hunk); }
  async unstage(filePath: string, hunk?: GitDiffHunk): Promise<void> { await this.updateIndex("unstage", filePath, hunk); }

  async branches(): Promise<GitBranch[]> {
    const output = await this.git(["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(HEAD)%00", "refs/heads", "refs/remotes"]);
    return output.split("\n").filter(Boolean).map((line) => { const [ref, name, head] = line.split("\0"); return { name: name!, current: head === "*", remote: ref!.startsWith("refs/remotes/") }; }).filter((item) => !item.name.endsWith("/HEAD"));
  }

  async tags(): Promise<GitTag[]> {
    const output = await this.git(["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(objecttype)", "refs/tags"]);
    return output.split("\n").filter(Boolean).map((line) => {
      const [name, target, type] = line.split("\0");
      return { name: name!, target: target!, annotated: type === "tag" };
    });
  }

  async createTag(name: string, target: string): Promise<GitTag> {
    validateTagName(name); validateHash(target);
    try { await this.git(["cat-file", "-e", `${target}^{commit}`]); }
    catch { throw new CoreError("INVALID_REQUEST", "Tag target must be an existing commit"); }
    await this.git(["tag", name, target]);
    const tag = (await this.tags()).find((item) => item.name === name);
    if (!tag) throw new CoreError("GIT_FAILED", `Git did not create local tag '${name}'`);
    return tag;
  }

  async deleteTag(name: string): Promise<void> {
    validateTagName(name);
    await this.git(["tag", "-d", name]);
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
    await this.ensureBranchNotCheckedOut(branch);
    await this.git(["branch", "-m", branch, newName]);
    return (await this.status()).branch;
  }

  async createBranch(name: string): Promise<string> { validateBranchName(name); await this.git(["branch", name]); return name; }
  async branchDeletePreview(branch: string, remote: boolean): Promise<GitBranchDeletePreview> { const reference = await this.branchReference(branch, remote); const unmerged = parseGitLog(await this.git(["log", "--max-count=50", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00", reference, "--not", "HEAD"])); return { branch, remote, unmerged, confirmationRequired: remote || unmerged.length > 0 }; }
  async deleteBranch(branch: string, remote: boolean, force: boolean, confirm: boolean): Promise<void> {
    if (typeof force !== "boolean" || typeof confirm !== "boolean") throw new CoreError("INVALID_REQUEST", "Branch deletion confirmation is required"); const reference = await this.branchReference(branch, remote);
    if (!remote) { await this.ensureBranchNotCheckedOut(branch); const preview = await this.branchDeletePreview(branch, false); if ((force || preview.confirmationRequired) && !confirm) throw new CoreError("INVALID_REQUEST", "Confirm deletion of an unmerged or forced branch"); await this.git(["branch", force ? "-D" : "-d", branch]); return; }
    if (!confirm) throw new CoreError("INVALID_REQUEST", "Confirm remote branch deletion"); const { remoteName, branchName } = splitRemoteBranch(reference); await this.networkGit(["push", remoteName, "--delete", branchName]);
  }
  async publishBranch(branch: string, remote: string, force: boolean, confirm: boolean): Promise<void> { validateBranchName(branch); await this.requireLocalBranch(branch); await this.requireRemote(remote); if (typeof force !== "boolean" || typeof confirm !== "boolean" || !confirm) throw new CoreError("INVALID_REQUEST", force ? "Confirm force publishing this branch" : "Confirm publishing this branch to the remote"); await this.networkGit(["push", ...(force ? ["--force-with-lease"] : []), "--set-upstream", remote, branch]); }
  async setBranchUpstream(branch: string, remote: string, upstream: string, confirm: boolean): Promise<void> { validateBranchName(branch); validateBranchName(upstream); await this.requireLocalBranch(branch); await this.branchReference(`${remote}/${upstream}`, true); if (typeof confirm !== "boolean" || !confirm) throw new CoreError("INVALID_REQUEST", "Confirm changing this branch's upstream"); await this.git(["branch", "--set-upstream-to", `${remote}/${upstream}`, branch]); }

  async log(branch: string, limit = 200): Promise<GitCommit[]> {
    if (!/^[\w./@{}~^:+-]+$/.test(branch)) throw new CoreError("INVALID_REQUEST", "Invalid Git branch");
    return parseGitGraphLog(await this.git(["log", branch, "--graph", "--date-order", `--max-count=${Math.max(1, Math.min(500, limit))}`, "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%D"]));
  }

  async commitFiles(hash: string): Promise<GitCommitFile[]> {
    validateHash(hash);
    return parseCommitFiles(await this.git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", hash]));
  }

  async commitMessage(hash: string): Promise<string> {
    validateHash(hash);
    return (await this.git(["show", "-s", "--format=%B", hash])).replace(/\n$/, "");
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

  async historyRewritePreview(): Promise<GitHistoryRewritePreview> {
    const commit = await this.headCommit();
    const [commitFiles, status, publication, hasParent] = await Promise.all([this.commitFiles(commit.hash), this.status(), this.headPublication(), this.hasHeadParent()]);
    return {
      commit,
      commitFiles,
      indexEntries: status.entries.filter((entry) => entry.states.includes("index")),
      worktreeEntries: status.entries.filter((entry) => entry.states.includes("worktree") || entry.states.includes("untracked")),
      publication,
      confirmationRequired: publication !== "unpublished",
      canUndo: hasParent,
      ...(hasParent ? {} : { undoUnavailableReason: "The root commit cannot be undone safely from this interface." }),
      recovery: `If needed, recover ${commit.shortHash} with git reflog, then git reset --hard ${commit.hash}.`
    };
  }

  async amend(confirmHistoryRewrite: boolean): Promise<string> {
    const preview = await this.historyRewritePreview();
    this.requireRewriteConfirmation(preview, confirmHistoryRewrite);
    if (preview.indexEntries.length === 0) throw new CoreError("INVALID_REQUEST", "Stage changes before amending; amend only uses the explicit Git index");
    await this.git(["commit", "--amend", "--no-edit"]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async undoLastCommit(confirmHistoryRewrite: boolean): Promise<string> {
    const preview = await this.historyRewritePreview();
    if (!preview.canUndo) throw new CoreError("INVALID_REQUEST", preview.undoUnavailableReason!);
    this.requireRewriteConfirmation(preview, confirmHistoryRewrite);
    await this.git(["reset", "--mixed", "HEAD^"]);
    return preview.commit.hash;
  }

  async push(): Promise<void> {
    await this.git(["push"]);
  }

  async fetch(): Promise<{ fetchedAt: string }> {
    const existing = GitService.fetches.get(this.workspace);
    if (existing?.controller) throw new CoreError("GIT_FAILED", "A Git fetch is already in progress");
    const controller = new AbortController();
    GitService.fetches.set(this.workspace, { controller, ...(existing?.lastSuccessful ? { lastSuccessful: existing.lastSuccessful } : {}) });
    try {
      await execFileAsync("git", ["-C", this.workspace, "fetch", "--prune"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal: controller.signal });
      const fetchedAt = new Date().toISOString();
      GitService.fetches.set(this.workspace, { controller, lastSuccessful: fetchedAt });
      return { fetchedAt };
    } catch (error) {
      if (controller.signal.aborted) throw new CoreError("GIT_FAILED", "Git fetch was cancelled");
      throw new CoreError("GIT_FAILED", gitNetworkError(error));
    } finally {
      const current = GitService.fetches.get(this.workspace);
      if (current?.controller === controller) GitService.fetches.set(this.workspace, { ...(current.lastSuccessful ? { lastSuccessful: current.lastSuccessful } : {}) });
    }
  }

  cancelFetch(): boolean {
    const fetch = GitService.fetches.get(this.workspace);
    if (!fetch?.controller || fetch.controller.signal.aborted) return false;
    fetch.controller.abort();
    return true;
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
  private async networkGit(args: string[]): Promise<string> { try { return (await execFileAsync("git", ["-C", this.workspace, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout; } catch (error) { throw new CoreError("GIT_FAILED", gitNetworkError(error)); } }
  private async requireLocalBranch(branch: string): Promise<void> { try { await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); } catch { throw new CoreError("INVALID_REQUEST", `Local branch '${branch}' does not exist`); } }
  private async requireRemote(remote: string): Promise<void> { if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new CoreError("INVALID_REQUEST", "Invalid Git remote"); const remotes = (await this.git(["remote"])).split("\n").filter(Boolean); if (!remotes.includes(remote)) throw new CoreError("INVALID_REQUEST", `Git remote '${remote}' does not exist`); }
  private async branchReference(branch: string, remote: boolean): Promise<string> { if (!remote) { validateBranchName(branch); await this.requireLocalBranch(branch); return branch; } const { remoteName, branchName } = splitRemoteBranch(branch); await this.requireRemote(remoteName); try { await this.git(["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branchName}`]); } catch { throw new CoreError("INVALID_REQUEST", `Remote branch '${branch}' does not exist`); } return branch; }
  private async ensureBranchNotCheckedOut(branch: string): Promise<void> { const output = await this.git(["worktree", "list", "--porcelain"]); if (output.split("\n").some((line) => line === `branch refs/heads/${branch}`)) throw new CoreError("INVALID_REQUEST", "Cannot delete a branch checked out by a workspace or task worktree"); }

  private async headCommit(): Promise<GitCommit> {
    try {
      const commit = parseGitLog(await this.git(["log", "-1", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00"]))[0];
      if (!commit) throw new Error("No HEAD");
      return commit;
    }
    catch { throw new CoreError("INVALID_REQUEST", "There is no local commit to amend or undo"); }
  }

  private async headPublication(): Promise<"unpublished" | "published" | "unknown"> {
    try {
      const upstream = (await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
      if (!upstream) return "unknown";
      const [head, base] = await Promise.all([this.git(["rev-parse", "HEAD"]), this.git(["merge-base", "HEAD", upstream])]);
      return head.trim() === base.trim() ? "published" : "unpublished";
    } catch { return "unknown"; }
  }

  private async hasHeadParent(): Promise<boolean> {
    try { await this.git(["rev-parse", "--verify", "HEAD^"]); return true; }
    catch { return false; }
  }

  private requireRewriteConfirmation(preview: GitHistoryRewritePreview, confirmed: boolean): void {
    if (typeof confirmed !== "boolean") throw new CoreError("INVALID_REQUEST", "History rewrite confirmation is required");
    if (preview.confirmationRequired && !confirmed) throw new CoreError("INVALID_REQUEST", preview.publication === "published" ? "This commit is published; confirm rewriting shared history to continue" : "The publication state is unknown; confirm history rewrite to continue");
  }

  private async updateIndex(action: "stage" | "unstage", filePath: string, hunk?: GitDiffHunk): Promise<void> {
    validatePath(filePath);
    const entry = (await this.status()).entries.find((item) => item.path === filePath);
    if (!entry) throw new CoreError("GIT_FAILED", `Path has no Git changes: ${filePath}`);
    if (entry.states.includes("conflict")) throw new CoreError("GIT_FAILED", "Cannot stage or unstage a conflicted file");
    if (!hunk) {
      const paths = entry.originalPath ? [entry.originalPath, filePath] : [filePath];
      if (action === "stage") { await this.git(["add", "-A", "--", ...paths]); return; }
      if (!await this.hasHead()) { await this.git(["rm", "--cached", "--ignore-unmatch", "--", ...paths]); return; }
      await this.git(["restore", "--staged", "--", ...paths]); return;
    }
    if (!isGitHunk(hunk)) throw new CoreError("INVALID_REQUEST", "Invalid Git hunk");
    if (hunk.source !== (action === "stage" ? "worktree" : "index")) throw new CoreError("INVALID_REQUEST", `A ${action} hunk must come from the ${action === "stage" ? "worktree" : "index"}`);
    const currentPatch = hunk.source === "worktree" ? (isUntracked(entry) ? await this.untrackedPatch(filePath) : await this.git(["diff", "--unified=0", "--", filePath])) : await this.git(["diff", "--cached", "--unified=0", "--", filePath]);
    const current = parseDiffHunks(currentPatch, hunk.source).find((item) => item.patch === hunk.patch && item.version === hunk.version);
    if (!current) throw new CoreError("GIT_FAILED", "Git change no longer matches the reviewed hunk. Refresh the diff and try again.");
    try { await applyGitPatch(this.workspace, hunk.patch, action === "unstage"); }
    catch (error) { throw new CoreError("GIT_FAILED", `Git change no longer matches the ${hunk.source} version. Refresh the diff and try again.`); }
  }

  private async untrackedPatch(filePath: string): Promise<string> {
    const result = await execFileAsync("git", ["-C", this.workspace, "diff", "--no-index", "--unified=0", "--", "/dev/null", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    return result.stdout;
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

function gitNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)/i.test(safe)) return "Git authentication failed. Check your remote credentials and try again.";
  return `Could not fetch remote: ${safe}`;
}

function isUntracked(entry: GitStatusEntry): boolean { return entry.indexStatus === "?" && entry.worktreeStatus === "?"; }

export function parseDiffHunks(output: string, source: "index" | "worktree" = "worktree"): GitDiffHunk[] {
  const matches = [...output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)];
  const header = output.slice(0, matches[0]?.index ?? 0);
  return matches.map((match, index) => {
    const patch = header + output.slice(match.index, matches[index + 1]?.index);
    return { originalStart: Number(match[1]), originalLines: Number(match[2] ?? 1), modifiedStart: Number(match[3]), modifiedLines: Number(match[4] ?? 1), source, patch, version: createHash("sha256").update(patch).digest("hex") };
  });
}

function validateHash(hash: string): void { if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new CoreError("INVALID_REQUEST", "Invalid commit hash"); }
function validateRef(ref: string): void { if (!/^[\w./@{}~^:+-]+$/.test(ref)) throw new CoreError("INVALID_REQUEST", "Invalid Git reference"); }
function validateBranchName(name: string): void { if (!name || !/^[\w./-]+$/.test(name) || name.startsWith("-") || name.includes("..") || name.includes("//") || name.endsWith("/")) throw new CoreError("INVALID_REQUEST", "Invalid Git branch name"); }
function splitRemoteBranch(value: string): { remoteName: string; branchName: string } { const [remoteName, ...parts] = value.split("/"); const branchName = parts.join("/"); if (!remoteName || !branchName) throw new CoreError("INVALID_REQUEST", "Remote branch must include a remote and branch name"); validateBranchName(branchName); return { remoteName, branchName }; }
/** Accept a short, unambiguous local tag name; refs/tags/* and revision syntax are deliberately refused. */
export function validateTagName(name: string): void {
  if (!name || name.length > 255 || name.startsWith("-") || name.startsWith("refs/") || name === "@" || name === "HEAD" || /[\s~^:?*\\[\x00-\x1f\x7f]/.test(name) || name.includes("@{") || name.includes("..") || name.includes("//") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock") || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new CoreError("INVALID_REQUEST", "Invalid or ambiguous local tag name");
}
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
    const entry: GitStatusEntry = { path: record.slice(3), indexStatus, worktreeStatus, states: gitChangeStates(indexStatus, worktreeStatus) };
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      entry.originalPath = records[index + 1];
      index += 1;
    }
    entries.push(entry);
  }
  return { branch, entries };
}

function gitChangeStates(indexStatus: string, worktreeStatus: string): GitStatusEntry["states"] {
  if (indexStatus === "?" && worktreeStatus === "?") return ["untracked"];
  if (indexStatus === "U" || worktreeStatus === "U" || ["AA", "DD"].includes(indexStatus + worktreeStatus)) return ["conflict"];
  return [indexStatus !== " " ? "index" : undefined, worktreeStatus !== " " ? "worktree" : undefined].filter((state): state is "index" | "worktree" => Boolean(state));
}

function isGitHunk(value: GitDiffHunk): boolean {
  return (value.source === "index" || value.source === "worktree") && Number.isInteger(value.originalStart) && Number.isInteger(value.originalLines) && Number.isInteger(value.modifiedStart) && Number.isInteger(value.modifiedLines) && value.originalStart >= 0 && value.originalLines >= 0 && value.modifiedStart >= 0 && value.modifiedLines >= 0 && typeof value.patch === "string" && value.patch.length > 0 && value.patch.length <= 4 * 1024 * 1024 && /^[0-9a-f]{64}$/.test(value.version);
}

async function applyGitPatch(workspace: string, patch: string, reverse: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", workspace, "apply", "--cached", "--unidiff-zero", ...(reverse ? ["--reverse"] : [])], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || "git apply failed")));
    child.stdin.end(patch);
  });
}
