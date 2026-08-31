export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};
/** A bounded, Core-authoritative view of paths affected by a watcher burst. */
export type FilesystemSnapshotEntry = { path: string; type?: "file" | "directory" };
/** Opaque Core-issued file identity and content revision used for conditional saves. */
export type FileRevision = { identity: string; version: string };
/**
 * The wire contract is independently versioned from package releases so a cached
 * Desktop can prove it is safe to talk to a newly deployed Core.
 */
export type ProtocolCompatibility = { minimum: number; maximum: number };
export const protocolCompatibility: ProtocolCompatibility = { minimum: 2, maximum: 2 };

export function protocolRangeIsValid(range: ProtocolCompatibility): boolean {
  return Number.isInteger(range.minimum) && Number.isInteger(range.maximum) && range.minimum > 0 && range.minimum <= range.maximum;
}

export function protocolRangesOverlap(left: ProtocolCompatibility, right: ProtocolCompatibility): boolean {
  return protocolRangeIsValid(left) && protocolRangeIsValid(right) && left.minimum <= right.maximum && right.minimum <= left.maximum;
}
export type FilesystemDeletePreview = { path: string; type: "file" | "directory"; children: string[]; childCount: number; recoverable: boolean };
export type FilesystemDeleteResult = { path: string; recoveryId?: string; permanentlyDeleted: boolean };

export type GitStatusEntry = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  /** Separate Git areas represented by this row; a partially staged file has both index and worktree. */
  states: GitChangeState[];
};
export type GitChangeState = "index" | "worktree" | "untracked" | "conflict";
/** The configured upstream and the last remote information Core successfully obtained. */
export type GitUpstreamStatus = { upstream: string; ahead: number; behind: number; lastFetch?: string };
export type GitBranch = { name: string; current: boolean; remote: boolean };
export type GitBranchDeletePreview = { branch: string; remote: boolean; unmerged: GitCommit[]; confirmationRequired: boolean };
/** A tag stored in this workspace's local Git repository. It is not a remote tag operation. */
export type GitTag = { name: string; target: string; annotated: boolean };
export type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string; parents?: string[]; refs?: string[]; graph?: string };
export type GitCommitFile = { path: string; status: string; originalPath?: string };
export type GitHistoryRewritePreview = {
  commit: GitCommit;
  commitFiles: GitCommitFile[];
  indexEntries: GitStatusEntry[];
  worktreeEntries: GitStatusEntry[];
  publication: "unpublished" | "published" | "unknown";
  confirmationRequired: boolean;
  canUndo: boolean;
  undoUnavailableReason?: string;
  recovery: string;
};
/** Inclusion is deliberately explicit because Git's default stash behavior excludes untracked and ignored files. */
export type GitStashInclusion = { staged: boolean; unstaged: boolean; untracked: boolean; ignored: boolean };
export type GitStash = { reference: string; hash: string; message: string; branch?: string; date?: string };
export type GitStashPreview = { stash: GitStash; files: GitCommitFile[]; conflictRisk: "none" | "possible"; blockers: string[]; recovery: string };
/** Patch and version are opaque Core-issued values; they prevent applying a hunk after its source changed. */
export type GitDiffHunk = { originalStart: number; originalLines: number; modifiedStart: number; modifiedLines: number; source: "index" | "worktree"; patch: string; version: string };
export type GitRollbackFailure = { path: string; message: string };
export type TaskCheckpointFile = { path: string; status: "A" | "M" | "D" | "R"; originalPath?: string; binary: boolean; size: number };
/** The result of comparing a checkpoint's before/after snapshots with the live worktree. */
export type TaskCheckpointApplyResult = { applied: string[]; alreadyApplied: string[]; conflicts: { path: string; message: string }[] };
/** Compact, redacted turn metadata. It deliberately excludes prompt/attachment bodies and logs. */
export type TaskCheckpointProvenance = {
  model?: string; reasoning?: string; agent?: { name: string; fingerprint: string };
  attachments?: { name: string; mimeType?: string; kind: "image" | "resource" | "resource_link" | "text" }[];
  usage?: { total: number; input: number; output: number; thought?: number; cachedRead?: number; cachedWrite?: number };
  commit?: string;
};
export type TaskCheckpoint = {
  id: string; promptId: string; sessionId?: string; provider: AiProvider; prompt: string;
  startedAt: string; completedAt?: string; status: "running" | "completed" | "interrupted" | "error";
  files: TaskCheckpointFile[];
  provenance?: TaskCheckpointProvenance;
};

export type WorkspaceOptions = {
  openFiles: string[];
  /** Pinned file paths, in their leading tab-strip order. */
  pinnedFiles?: string[];
  activeFile?: string;
  javaProject?: JavaProjectOptions;
  terminal?: WorkspaceTerminalOptions;
  fileColors?: Record<string, FileColor>;
  gitCommitMessage?: string;
  searchQueries?: WorkspaceSearchQueries;
};
/** Compact Find in Files metadata. Search results and file contents are never persisted. */
export type WorkspaceSearchQuery = { query: string; path: string; matchCase?: boolean; include?: string; exclude?: string };
export type WorkspaceSearchQueries = { recent?: WorkspaceSearchQuery[]; saved?: WorkspaceSearchQuery[] };
export type FileColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
/** Durable terminal-tab metadata. The display name is UI state, not a PTY identity. */
export type WorkspaceTerminalOptions = { tabs: { displayName: string; terminalId?: string }[]; activeTabIndex?: number; panelOpen: boolean };
export type TerminalSessionSnapshot = { terminalId: string; status: "running" | "exited"; output: string; exitCode?: number };
/** Resolution is always against the currently selected workspace. A stale ID means Core no longer owns that process. */
export type TerminalAttachResult = { state: "available"; session: TerminalSessionSnapshot } | { state: "stale"; reason: "session-unavailable" };
export type WorkspaceTask = { id: string; name: string; branch: string; baseBranch: string; status: "active" | "finished"; archived: boolean };
export type { AiAgent, AiCommand, AiConfiguration, AiContentBlock, AiMessage, AiModel, AiMcpServer, AiOption, AiPermissionRequest, AiProvider, AiProviderCapabilities, AiProviderDescriptor, AiSession, AiSettingsLayout, AiSettingsSection, AiStatus, AiTaskSummary, AiUsage } from "@remote-ide/acp";
import type { AiAgent, AiConfiguration, AiContentBlock, AiMcpServer, AiModel, AiProvider, AiProviderDescriptor, AiSession, AiTaskSummary, AiUsage } from "@remote-ide/acp";
export type UsefulFileScope = "global" | "local";
export type UsefulFile = { scope: UsefulFileScope; name: string };
export type RunConfigScope = "global" | "local";
export type RunConfigStatus = "idle" | "starting" | "running" | "stopping" | "succeeded" | "failed";
export type RunConfig = { scope: RunConfigScope; name: string; commands: string; status: RunConfigStatus; terminalId?: string; exitCode?: number };
export type AgentFileScope = "global" | "local" | "workspace";
export type AgentFileReference = { scope: AgentFileScope; name: string };
export type AgentFile = { scope: AgentFileScope; name: string; agent: AiAgent };
export type HttpResponse = { status: number; statusText: string; headers: Record<string, string>; body: string; durationMs: number };

export type JavaProjectOptions = {
  type: "maven";
  pomPath: string;
  mavenExecutable: string;
  sourceRoots: string[];
  outputPath: string;
  testOutputPath: string;
  runConfigurations: JavaRunConfiguration[];
  selectedRunConfigurationId?: string;
};

export type JavaRunConfiguration = { id: string; name: string; mainClass: string };
export type JavaMainClass = { className: string; path: string };
export type JavaBreakpoint = { path: string; line: number; className: string };
export type JavaDebugVariable = { name: string; value: string };
export type JavaDebugState = {
  status: "starting" | "running" | "paused" | "stopped";
  className?: string;
  method?: string;
  line?: number;
  variables: JavaDebugVariable[];
};
export type JavaDiagnostic = { path: string; line: number; column: number; severity: "error" | "warning"; message: string };
export type JavaTypeSuggestion = { simpleName: string; qualifiedName: string; source: "project" | "dependency" };
export type JavaLspRange = { startLine: number; startColumn: number; endLine: number; endColumn: number };
export type JavaLspCompletion = { label: string; detail?: string; insertText: string; range?: JavaLspRange; additionalTextEdits: { range: JavaLspRange; text: string }[] };
export type JavaLspLocation = { path: string } & JavaLspRange;
export type JavaSemanticToken = JavaLspRange & { type: string; modifiers: string[] };

export type JavaProjectNode = {
  name: string;
  path: string;
  type: "sourceRoot" | "package" | "file";
  children?: JavaProjectNode[];
};

export type SearchContextLine = { line: number; text: string; truncated: boolean };
export type SearchMatchContext = { before: SearchContextLine[]; after: SearchContextLine[]; truncatedBefore: boolean; truncatedAfter: boolean };
export type SearchResult = { path: string; line: number; column: number; preview: string; previewTruncated?: boolean; context?: SearchMatchContext };
export type SearchReplacePreviewFile = { path: string; revision: FileRevision; occurrences: { line: number; column: number; before: string; after: string }[] };
export type SearchReplacePreview = { id: string; files: SearchReplacePreviewFile[]; truncated: boolean };
export type SearchReplaceApplyResult = { applied: { path: string; revision: FileRevision }[]; failures: { path: string; code: string; message: string }[] };

export type ProtocolOperations = {
  "protocol.handshake": { payload: { compatibility: ProtocolCompatibility; clientVersion?: string }; result: { compatible: boolean; compatibility: ProtocolCompatibility; message?: string } };
  "workspace.open": {
    payload: { includeIgnored?: boolean };
    result: { workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions };
  };
  "workspace.saveOptions": {
    payload: { options: WorkspaceOptions };
    result: Record<string, never>;
  };
  "tasks.list": { payload: Record<string, never>; result: { tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "tasks.create": { payload: { branch: string; existing?: boolean; remote?: boolean }; result: { task: WorkspaceTask } };
  "tasks.createFromPrompt": { payload: { provider?: AiProvider; prompt: string; content?: AiContentBlock[]; configuration: AiConfiguration; mcpServers?: AiMcpServer[]; agent?: AiAgent }; result: { task: WorkspaceTask } };
  "tasks.merge": { payload: { taskId: string; strategy?: "merge" | "smart" }; result: { targetBranch: string } };
  "tasks.timer.cancel": { payload: { taskId?: string }; result: { cancelled: boolean } };
  "tasks.timer.fire": { payload: { taskId?: string }; result: { fired: boolean } };
  "tasks.status": { payload: { taskId: string; status: "active" | "finished" }; result: { task: WorkspaceTask } };
  "tasks.rename": { payload: { taskId: string; name: string }; result: { task: WorkspaceTask } };
  "tasks.archive": { payload: { taskId: string; archived: boolean }; result: { task: WorkspaceTask } };
  "tasks.switch": { payload: { taskId?: string; includeIgnored?: boolean }; result: { workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions; tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "tasks.delete": { payload: { taskId: string }; result: { tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "ai.providers": { payload: Record<string, never>; result: { providers: AiProviderDescriptor[] } };
  "ai.get": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.models": { payload: { provider?: AiProvider }; result: { models: AiModel[] } };
  "ai.configure": { payload: { provider?: AiProvider; model?: string; reasoning?: string; configuration?: AiConfiguration }; result: { session: AiSession } };
  "ai.send": { payload: { provider?: AiProvider; prompt: string; content?: AiContentBlock[]; model?: string; reasoning?: string; configuration?: AiConfiguration; mcpServers?: AiMcpServer[]; agent?: AiAgent }; result: { session: AiSession } };
  "ai.permission.resolve": { payload: { provider?: AiProvider; requestId: string; optionId?: string; target?: { taskId?: string; sessionId?: string } }; result: { session: AiSession } };
  "ai.interrupt": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.steer": { payload: { provider?: AiProvider; prompt: string }; result: { session: AiSession } };
  "ai.clear": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.sessions": { payload: { provider?: AiProvider }; result: { sessions: AiSession[] } };
  "ai.restore": { payload: { provider?: AiProvider; sessionId: string }; result: { session: AiSession } };
  "ai.remove": { payload: { provider?: AiProvider; sessionId: string }; result: { session: AiSession } };
  "ai.usage": { payload: { provider?: AiProvider }; result: { usage: AiUsage } };
  "ai.statuses": { payload: Record<string, never>; result: { root: AiTaskSummary; tasks: Record<string, AiTaskSummary> } };
  "useful.list": { payload: Record<string, never>; result: { files: UsefulFile[] } };
  "useful.read": { payload: { scope: UsefulFileScope; name: string }; result: { content: string } };
  "useful.create": { payload: { scope: UsefulFileScope; name: string }; result: Record<string, never> };
  "useful.write": { payload: { scope: UsefulFileScope; name: string; content: string }; result: Record<string, never> };
  "useful.rename": { payload: { scope: UsefulFileScope; name: string; newName: string }; result: Record<string, never> };
  "useful.delete": { payload: { scope: UsefulFileScope; name: string }; result: Record<string, never> };
  "runConfig.list": { payload: Record<string, never>; result: { configs: RunConfig[] } };
  "runConfig.create": { payload: { scope: RunConfigScope; name: string; commands: string }; result: { config: RunConfig } };
  "runConfig.read": { payload: { scope: RunConfigScope; name: string }; result: { config: RunConfig } };
  "runConfig.write": { payload: { scope: RunConfigScope; name: string; commands: string }; result: { config: RunConfig } };
  "runConfig.rename": { payload: { scope: RunConfigScope; name: string; newName: string }; result: { config: RunConfig } };
  "runConfig.delete": { payload: { scope: RunConfigScope; name: string }; result: Record<string, never> };
  "runConfig.run": { payload: { scope: RunConfigScope; name: string }; result: { config: RunConfig } };
  "runConfig.stop": { payload: { scope: RunConfigScope; name: string }; result: { config: RunConfig } };
  "runConfig.restart": { payload: { scope: RunConfigScope; name: string }; result: { config: RunConfig } };
  "runConfig.openTerminal": { payload: { scope: RunConfigScope; name: string }; result: { config: RunConfig } };
  "agents.list": { payload: Record<string, never>; result: { agents: AgentFile[] } };
  "agents.read": { payload: { scope: AgentFileScope; name: string }; result: { content: string } };
  "agents.create": { payload: { scope: Exclude<AgentFileScope, "workspace">; name: string }; result: Record<string, never> };
  "agents.write": { payload: { scope: AgentFileScope; name: string; content: string }; result: Record<string, never> };
  "agents.rename": { payload: { scope: Exclude<AgentFileScope, "workspace">; name: string; newName: string }; result: { name: string } };
  "agents.delete": { payload: { scope: Exclude<AgentFileScope, "workspace">; name: string }; result: Record<string, never> };
  "http.execute": { payload: { method: string; url: string; headers: Record<string, string>; body?: string }; result: HttpResponse };
  "filesystem.listTree": {
    payload: { includeIgnored?: boolean };
    result: { tree: FileTreeNode[] };
  };
  "filesystem.snapshot": {
    payload: { paths: string[] };
    result: { entries: FilesystemSnapshotEntry[] };
  };
  "filesystem.readFile": {
    payload: { path: string };
    result: { path: string; content: string; revision: FileRevision };
  };
  "filesystem.writeFile": {
    payload: { path: string; content: string; expectedRevision?: FileRevision; force?: boolean; create?: boolean };
    result: { path: string; bytesWritten: number; revision: FileRevision };
  };
  "filesystem.createFile": {
    payload: { path: string };
    result: { path: string };
  };
  "filesystem.createDirectory": {
    payload: { path: string };
    result: { path: string };
  };
  "filesystem.rename": {
    payload: { path: string; newPath: string };
    result: { path: string };
  };
  "filesystem.previewDelete": {
    payload: { path: string };
    result: FilesystemDeletePreview;
  };
  "filesystem.delete": {
    payload: { path: string; permanent?: boolean };
    result: FilesystemDeleteResult;
  };
  "filesystem.restore": {
    payload: { recoveryId: string };
    result: { path: string };
  };
  "filesystem.search": {
    payload: { query: string; path: string; matchCase: boolean; include?: string; exclude?: string };
    result: { matches: SearchResult[]; truncated: boolean };
  };
  "filesystem.replacePreview": {
    payload: { query: string; replacement: string; path: string; matchCase: boolean; include?: string; exclude?: string };
    result: SearchReplacePreview;
  };
  "filesystem.replaceApply": {
    payload: { previewId: string; confirmed: boolean };
    result: SearchReplaceApplyResult;
  };
  "terminal.create": {
    payload: { cols: number; rows: number };
    result: TerminalSessionSnapshot;
  };
  "terminal.attach": {
    payload: { terminalId: string };
    result: TerminalAttachResult;
  };
  "terminal.input": {
    payload: { terminalId: string; data: string };
    result: Record<string, never>;
  };
  "terminal.resize": {
    payload: { terminalId: string; cols: number; rows: number };
    result: Record<string, never>;
  };
  "terminal.close": {
    payload: { terminalId: string };
    result: Record<string, never>;
  };
  "git.status": {
    payload: Record<string, never>;
    result: { branch: string; entries: GitStatusEntry[]; upstream?: GitUpstreamStatus };
  };
  "git.diff": {
    payload: { path: string };
    result: { path: string; originalContent: string; modifiedContent: string; hunks: GitDiffHunk[] };
  };
  "git.stage": { payload: { path: string; hunk?: GitDiffHunk }; result: Record<string, never> };
  "git.unstage": { payload: { path: string; hunk?: GitDiffHunk }; result: Record<string, never> };
  "git.branches": { payload: Record<string, never>; result: { branches: GitBranch[] } };
  "git.tags": { payload: Record<string, never>; result: { tags: GitTag[] } };
  "git.createTag": { payload: { name: string; target: string }; result: { tag: GitTag } };
  "git.deleteTag": { payload: { name: string }; result: Record<string, never> };
  "git.checkoutBranch": { payload: { branch: string; remote?: boolean }; result: { branch: string } };
  "git.renameBranch": { payload: { branch: string; newName: string }; result: { branch: string } };
  "git.createBranch": { payload: { name: string }; result: { branch: string } };
  "git.branchDeletePreview": { payload: { branch: string; remote: boolean }; result: GitBranchDeletePreview };
  "git.deleteBranch": { payload: { branch: string; remote: boolean; force: boolean; confirm: boolean }; result: Record<string, never> };
  "git.publishBranch": { payload: { branch: string; remote: string; force: boolean; confirm: boolean }; result: Record<string, never> };
  "git.setBranchUpstream": { payload: { branch: string; remote: string; upstream: string; confirm: boolean }; result: Record<string, never> };
  "git.log": { payload: { branch: string; limit?: number }; result: { commits: GitCommit[] } };
  "git.commitFiles": { payload: { hash: string }; result: { files: GitCommitFile[] } };
  "git.commitMessage": { payload: { hash: string }; result: { message: string } };
  "git.commitDiff": { payload: { hash: string; path: string; originalPath?: string }; result: { originalContent: string; modifiedContent: string } };
  "git.cherryPick": { payload: { hash: string; commit: boolean }; result: { branch: string } };
  "git.fileHistory": { payload: { path: string; startLine?: number; endLine?: number }; result: { commits: GitCommit[] } };
  "git.compareFiles": { payload: { ref: string; path?: string }; result: { files: GitCommitFile[] } };
  "git.compareDiff": { payload: { ref: string; path: string; originalPath?: string }; result: { originalContent: string; modifiedContent: string } };
  "git.rollback": { payload: { path: string }; result: Record<string, never> };
  "git.rollbackSelected": { payload: { paths: string[]; deleteUntracked: boolean }; result: { rolledBack: string[]; failures: GitRollbackFailure[] } };
  "git.commit": { payload: { paths: string[]; message: string }; result: { hash: string } };
  "git.historyRewritePreview": { payload: Record<string, never>; result: GitHistoryRewritePreview };
  "git.amend": { payload: { confirmHistoryRewrite: boolean }; result: { hash: string } };
  "git.undoLastCommit": { payload: { confirmHistoryRewrite: boolean }; result: { undone: string } };
  "git.stashes": { payload: Record<string, never>; result: { stashes: GitStash[] } };
  "git.createStash": { payload: { message?: string; paths?: string[]; include: GitStashInclusion }; result: { stash: GitStash } };
  "git.stashPreview": { payload: { reference: string }; result: GitStashPreview };
  "git.applyStash": { payload: { reference: string }; result: { applied: boolean; stashRetained: boolean; outcome: string } };
  "git.popStash": { payload: { reference: string; confirm: boolean }; result: { applied: boolean; stashRetained: boolean; outcome: string } };
  "git.dropStash": { payload: { reference: string; confirm: boolean }; result: Record<string, never> };
  "git.push": { payload: Record<string, never>; result: Record<string, never> };
  "git.fetch": { payload: Record<string, never>; result: { fetchedAt: string } };
  "git.cancelFetch": { payload: Record<string, never>; result: { cancelled: boolean } };
  "taskGit.history": { payload: Record<string, never>; result: { checkpoints: TaskCheckpoint[] } };
  /** Text bodies are capped by Core; callers must not use this as bulk file retrieval. */
  "taskGit.diff": { payload: { checkpointId: string; path: string }; result: { originalContent: string; modifiedContent: string; binary: boolean; truncated: boolean } };
  /** Applies selected checkpoint files only when a three-way comparison has no conflict. Git's index is untouched. */
  "taskGit.review": { payload: { checkpointId: string; paths: string[] }; result: TaskCheckpointApplyResult };
  "taskGit.restore": { payload: { checkpointId: string }; result: TaskCheckpointApplyResult };
  "java.loadMavenProject": {
    payload: { pomPath: string };
    result: { options: JavaProjectOptions; tree: JavaProjectNode[] };
  };
  "java.getOptions": {
    payload: Record<string, never>;
    result: { options?: JavaProjectOptions };
  };
  "java.addSourceRoot": {
    payload: { path: string };
    result: { options: JavaProjectOptions; tree: JavaProjectNode[] };
  };
  "java.getProjectTree": {
    payload: Record<string, never>;
    result: { tree: JavaProjectNode[] };
  };
  "java.listMainClasses": {
    payload: Record<string, never>;
    result: { classes: JavaMainClass[] };
  };
  "java.addRunConfiguration": {
    payload: { name: string; mainClass: string };
    result: { options: JavaProjectOptions };
  };
  "java.selectRunConfiguration": {
    payload: { id: string };
    result: { options: JavaProjectOptions };
  };
  "java.build": {
    payload: Record<string, never>;
    result: Record<string, never>;
  };
  "java.run": {
    payload: Record<string, never>;
    result: Record<string, never>;
  };
  "java.stop": {
    payload: Record<string, never>;
    result: Record<string, never>;
  };
  "java.debug.start": {
    payload: { breakpoints: JavaBreakpoint[] };
    result: Record<string, never>;
  };
  "java.debug.command": {
    payload: { command: "continue" | "stepInto" | "stepOver" | "stepOut" };
    result: Record<string, never>;
  };
  "java.check": {
    payload: Record<string, never>;
    result: { diagnostics: JavaDiagnostic[] };
  };
  "java.completeType": {
    payload: { prefix: string };
    result: { suggestions: JavaTypeSuggestion[] };
  };
  "java.completion": { payload: { path: string; content: string; line: number; column: number }; result: { items: JavaLspCompletion[] } };
  "java.definition": { payload: { path: string; content: string; line: number; column: number }; result: { locations: JavaLspLocation[] } };
  "java.references": { payload: { path: string; content: string; line: number; column: number }; result: { locations: JavaLspLocation[] } };
  "java.semanticTokens": { payload: { path: string; content: string }; result: { tokens: JavaSemanticToken[] } };
};

export type RequestType = keyof ProtocolOperations;

export type Request<T extends RequestType = RequestType> = T extends RequestType
  ? { id: string; type: T; payload: ProtocolOperations[T]["payload"] }
  : never;

export type ErrorCode =
  | "INVALID_REQUEST"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_OPEN"
  | "PATH_OUTSIDE_WORKSPACE"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "BINARY_FILE"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "FILE_CHANGED"
  | "TERMINAL_FAILED"
  | "RUN_CONFIG_NOT_FOUND"
  | "RUN_CONFIG_RUNNING"
  | "RUN_CONFIG_FAILED"
  | "GIT_NOT_REPOSITORY"
  | "GIT_FAILED"
  | "JAVA_NOT_CONFIGURED"
  | "MAVEN_PROJECT_INVALID"
  | "JAVA_PROCESS_FAILED";

export type ProtocolError = { code: ErrorCode; message: string };

export type Response<T extends RequestType = RequestType> =
  | { id: string; ok: true; result: ProtocolOperations[T]["result"] }
  | { id: string; ok: false; error: ProtocolError };

export type FilesystemChangedEvent = {
  type: "filesystem.changed";
  payload: { paths: string[]; overflow: boolean; health: "healthy" | "degraded"; message?: string };
};

export type TerminalOutputEvent = {
  type: "terminal.output";
  payload: { terminalId: string; data: string };
};

export type TerminalExitEvent = {
  type: "terminal.exit";
  payload: { terminalId: string; exitCode: number };
};

export type GitChangedEvent = { type: "git.changed"; payload: Record<string, never> };
export type TaskGitChangedEvent = { type: "taskGit.changed"; payload: { workspace: string } };

export type JavaOutputEvent = { type: "java.output"; payload: { data: string } };
export type JavaExitEvent = { type: "java.exit"; payload: { exitCode: number | null; signal: string | null } };
export type JavaDebugStateEvent = { type: "java.debug.state"; payload: JavaDebugState };
export type AiChangedEvent = { type: "ai.changed"; payload: { workspace: string } };
export type TasksChangedEvent = { type: "tasks.changed"; payload: Record<string, never> };
export type CommitMessageChangedEvent = { type: "commit-message.changed"; payload: { workspace: string; message: string } };
export type RunConfigChangedEvent = { type: "runConfig.changed"; payload: { workspace: string; configs: RunConfig[] } };

export type ServerEvent = FilesystemChangedEvent | TerminalOutputEvent | TerminalExitEvent | GitChangedEvent | TaskGitChangedEvent | JavaOutputEvent | JavaExitEvent | JavaDebugStateEvent | AiChangedEvent | TasksChangedEvent | CommitMessageChangedEvent | RunConfigChangedEvent;

/**
 * Every request the core accepts. Declaring it as a fully keyed record makes TypeScript
 * fail the build when an operation is added to `ProtocolOperations` without being
 * registered here, which would otherwise reject the request at runtime.
 */
const requestTypeRegistry: Record<RequestType, true> = {
  "protocol.handshake": true,
  "workspace.open": true,
  "workspace.saveOptions": true,
  "tasks.list": true,
  "tasks.create": true,
  "tasks.createFromPrompt": true,
  "tasks.merge": true,
  "tasks.timer.cancel": true,
  "tasks.timer.fire": true,
  "tasks.status": true,
  "tasks.rename": true,
  "tasks.archive": true,
  "tasks.switch": true,
  "tasks.delete": true,
  "ai.providers": true,
  "ai.get": true,
  "ai.models": true,
  "ai.configure": true,
  "ai.send": true,
  "ai.permission.resolve": true,
  "ai.interrupt": true,
  "ai.steer": true,
  "ai.clear": true,
  "ai.sessions": true,
  "ai.restore": true,
  "ai.remove": true,
  "ai.usage": true,
  "ai.statuses": true,
  "useful.list": true,
  "useful.read": true,
  "useful.create": true,
  "useful.write": true,
  "useful.rename": true,
  "useful.delete": true,
  "runConfig.list": true,
  "runConfig.create": true,
  "runConfig.read": true,
  "runConfig.write": true,
  "runConfig.rename": true,
  "runConfig.delete": true,
  "runConfig.run": true,
  "runConfig.stop": true,
  "runConfig.restart": true,
  "runConfig.openTerminal": true,
  "agents.list": true,
  "agents.read": true,
  "agents.create": true,
  "agents.write": true,
  "agents.rename": true,
  "agents.delete": true,
  "http.execute": true,
  "filesystem.listTree": true,
  "filesystem.snapshot": true,
  "filesystem.readFile": true,
  "filesystem.writeFile": true,
  "filesystem.createFile": true,
  "filesystem.createDirectory": true,
  "filesystem.rename": true,
  "filesystem.previewDelete": true,
  "filesystem.delete": true,
  "filesystem.restore": true,
  "filesystem.search": true,
  "filesystem.replacePreview": true,
  "filesystem.replaceApply": true,
  "terminal.create": true,
  "terminal.attach": true,
  "terminal.input": true,
  "terminal.resize": true,
  "terminal.close": true,
  "git.status": true,
  "git.diff": true,
  "git.stage": true,
  "git.unstage": true,
  "git.branches": true,
  "git.tags": true,
  "git.createTag": true,
  "git.deleteTag": true,
  "git.checkoutBranch": true,
  "git.renameBranch": true,
  "git.createBranch": true,
  "git.branchDeletePreview": true,
  "git.deleteBranch": true,
  "git.publishBranch": true,
  "git.setBranchUpstream": true,
  "git.log": true,
  "git.commitFiles": true,
  "git.commitMessage": true,
  "git.commitDiff": true,
  "git.cherryPick": true,
  "git.fileHistory": true,
  "git.compareFiles": true,
  "git.compareDiff": true,
  "git.rollback": true,
  "git.rollbackSelected": true,
  "git.commit": true,
  "git.historyRewritePreview": true,
  "git.amend": true,
  "git.undoLastCommit": true,
  "git.stashes": true,
  "git.createStash": true,
  "git.stashPreview": true,
  "git.applyStash": true,
  "git.popStash": true,
  "git.dropStash": true,
  "git.push": true,
  "git.fetch": true,
  "git.cancelFetch": true,
  "taskGit.history": true,
  "taskGit.diff": true,
  "taskGit.review": true,
  "taskGit.restore": true,
  "java.loadMavenProject": true,
  "java.getOptions": true,
  "java.addSourceRoot": true,
  "java.getProjectTree": true,
  "java.listMainClasses": true,
  "java.addRunConfiguration": true,
  "java.selectRunConfiguration": true,
  "java.build": true,
  "java.run": true,
  "java.stop": true,
  "java.debug.start": true,
  "java.debug.command": true,
  "java.check": true,
  "java.completeType": true,
  "java.completion": true,
  "java.definition": true,
  "java.references": true,
  "java.semanticTokens": true,
};

export const requestTypes: RequestType[] = Object.keys(requestTypeRegistry) as RequestType[];
