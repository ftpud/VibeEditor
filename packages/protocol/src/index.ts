export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type GitStatusEntry = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
};
export type GitBranch = { name: string; current: boolean; remote: boolean };
export type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string; parents?: string[]; refs?: string[]; graph?: string };
export type GitCommitFile = { path: string; status: string; originalPath?: string };
export type GitDiffHunk = { originalStart: number; originalLines: number; modifiedStart: number; modifiedLines: number };

export type WorkspaceOptions = {
  openFiles: string[];
  activeFile?: string;
  javaProject?: JavaProjectOptions;
  terminal?: WorkspaceTerminalOptions;
  fileColors?: Record<string, FileColor>;
  gitCommitMessage?: string;
};
export type FileColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
export type WorkspaceTerminalOptions = { tabs: { title: string }[]; activeTabIndex?: number; panelOpen: boolean };
export type WorkspaceTask = { id: string; name: string; branch: string; baseBranch: string };
export type { AiAgent, AiCommand, AiConfiguration, AiContentBlock, AiMessage, AiModel, AiMcpServer, AiOption, AiPermissionRequest, AiProvider, AiProviderCapabilities, AiProviderDescriptor, AiSession, AiSettingsLayout, AiSettingsSection, AiStatus, AiTaskSummary, AiUsage } from "@remote-ide/acp";
import type { AiAgent, AiConfiguration, AiContentBlock, AiMcpServer, AiModel, AiProvider, AiProviderDescriptor, AiSession, AiTaskSummary, AiUsage } from "@remote-ide/acp";
export type UsefulFileScope = "global" | "local";
export type UsefulFile = { scope: UsefulFileScope; name: string };
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

export type SearchResult = { path: string; line: number; column: number; preview: string };

export type ProtocolOperations = {
  "workspace.open": {
    payload: Record<string, never>;
    result: { workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions };
  };
  "workspace.saveOptions": {
    payload: { options: WorkspaceOptions };
    result: Record<string, never>;
  };
  "tasks.list": { payload: Record<string, never>; result: { tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "tasks.create": { payload: { branch: string }; result: { task: WorkspaceTask } };
  "tasks.merge": { payload: { taskId: string }; result: { targetBranch: string } };
  "tasks.switch": { payload: { taskId?: string }; result: { workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions; tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "tasks.delete": { payload: { taskId: string }; result: { tasks: WorkspaceTask[]; selectedTaskId?: string } };
  "ai.providers": { payload: Record<string, never>; result: { providers: AiProviderDescriptor[] } };
  "ai.get": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.models": { payload: { provider?: AiProvider }; result: { models: AiModel[] } };
  "ai.configure": { payload: { provider?: AiProvider; model?: string; reasoning?: string; configuration?: AiConfiguration }; result: { session: AiSession } };
  "ai.send": { payload: { provider?: AiProvider; prompt: string; content?: AiContentBlock[]; model?: string; reasoning?: string; configuration?: AiConfiguration; mcpServers?: AiMcpServer[]; agent?: AiAgent }; result: { session: AiSession } };
  "ai.permission.resolve": { payload: { provider?: AiProvider; requestId: string; optionId?: string }; result: { session: AiSession } };
  "ai.interrupt": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.steer": { payload: { provider?: AiProvider; prompt: string }; result: { session: AiSession } };
  "ai.clear": { payload: { provider?: AiProvider }; result: { session: AiSession } };
  "ai.usage": { payload: { provider?: AiProvider }; result: { usage: AiUsage } };
  "ai.statuses": { payload: Record<string, never>; result: { root: AiTaskSummary; tasks: Record<string, AiTaskSummary> } };
  "useful.list": { payload: Record<string, never>; result: { files: UsefulFile[] } };
  "useful.read": { payload: { scope: UsefulFileScope; name: string }; result: { content: string } };
  "useful.create": { payload: { scope: UsefulFileScope; name: string }; result: Record<string, never> };
  "useful.write": { payload: { scope: UsefulFileScope; name: string; content: string }; result: Record<string, never> };
  "useful.rename": { payload: { scope: UsefulFileScope; name: string; newName: string }; result: Record<string, never> };
  "useful.delete": { payload: { scope: UsefulFileScope; name: string }; result: Record<string, never> };
  "http.execute": { payload: { method: string; url: string; headers: Record<string, string>; body?: string }; result: HttpResponse };
  "filesystem.listTree": {
    payload: Record<string, never>;
    result: { tree: FileTreeNode[] };
  };
  "filesystem.readFile": {
    payload: { path: string };
    result: { path: string; content: string };
  };
  "filesystem.writeFile": {
    payload: { path: string; content: string };
    result: { path: string; bytesWritten: number };
  };
  "filesystem.search": {
    payload: { query: string; path: string; matchCase: boolean };
    result: { matches: SearchResult[]; truncated: boolean };
  };
  "terminal.create": {
    payload: { cols: number; rows: number };
    result: { terminalId: string };
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
    result: { branch: string; entries: GitStatusEntry[] };
  };
  "git.diff": {
    payload: { path: string };
    result: { path: string; originalContent: string; modifiedContent: string; hunks: GitDiffHunk[] };
  };
  "git.branches": { payload: Record<string, never>; result: { branches: GitBranch[] } };
  "git.checkoutBranch": { payload: { branch: string; remote?: boolean }; result: { branch: string } };
  "git.renameBranch": { payload: { branch: string; newName: string }; result: { branch: string } };
  "git.log": { payload: { branch: string; limit?: number }; result: { commits: GitCommit[] } };
  "git.commitFiles": { payload: { hash: string }; result: { files: GitCommitFile[] } };
  "git.commitDiff": { payload: { hash: string; path: string; originalPath?: string }; result: { originalContent: string; modifiedContent: string } };
  "git.cherryPick": { payload: { hash: string; commit: boolean }; result: { branch: string } };
  "git.fileHistory": { payload: { path: string; startLine?: number; endLine?: number }; result: { commits: GitCommit[] } };
  "git.compareFiles": { payload: { ref: string; path?: string }; result: { files: GitCommitFile[] } };
  "git.compareDiff": { payload: { ref: string; path: string; originalPath?: string }; result: { originalContent: string; modifiedContent: string } };
  "git.rollback": { payload: { path: string }; result: Record<string, never> };
  "git.commit": { payload: { paths: string[]; message: string }; result: { hash: string } };
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
  | "TERMINAL_FAILED"
  | "GIT_NOT_REPOSITORY"
  | "GIT_FAILED"
  | "JAVA_NOT_CONFIGURED"
  | "MAVEN_PROJECT_INVALID"
  | "JAVA_PROCESS_FAILED";

export type ProtocolError = { code: ErrorCode; message: string };

export type Response<T extends RequestType = RequestType> =
  | { id: string; ok: true; result: ProtocolOperations[T]["result"] }
  | { id: string; ok: false; error: ProtocolError };

export type FileChangeKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export type FilesystemChangedEvent = {
  type: "filesystem.changed";
  payload: { path: string; kind: FileChangeKind };
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

export type JavaOutputEvent = { type: "java.output"; payload: { data: string } };
export type JavaExitEvent = { type: "java.exit"; payload: { exitCode: number | null; signal: string | null } };
export type JavaDebugStateEvent = { type: "java.debug.state"; payload: JavaDebugState };
export type AiChangedEvent = { type: "ai.changed"; payload: { workspace: string } };

export type ServerEvent = FilesystemChangedEvent | TerminalOutputEvent | TerminalExitEvent | GitChangedEvent | JavaOutputEvent | JavaExitEvent | JavaDebugStateEvent | AiChangedEvent;

export const requestTypes: RequestType[] = [
  "workspace.open",
  "workspace.saveOptions",
  "tasks.list",
  "tasks.create",
  "tasks.merge",
  "tasks.switch",
  "tasks.delete",
  "ai.providers",
  "ai.get",
  "ai.models",
  "ai.configure",
  "ai.send",
  "ai.permission.resolve",
  "ai.interrupt",
  "ai.steer",
  "ai.clear",
  "ai.usage",
  "ai.statuses",
  "useful.list",
  "useful.read",
  "useful.create",
  "useful.write",
  "useful.rename",
  "useful.delete",
  "http.execute",
  "filesystem.listTree",
  "filesystem.readFile",
  "filesystem.writeFile",
  "filesystem.search",
  "terminal.create",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
  "git.status",
  "git.diff",
  "git.branches",
  "git.checkoutBranch",
  "git.renameBranch",
  "git.log",
  "git.commitFiles",
  "git.commitDiff",
  "git.cherryPick",
  "git.fileHistory",
  "git.compareFiles",
  "git.compareDiff",
  "git.rollback",
  "git.commit",
  "java.loadMavenProject",
  "java.getOptions",
  "java.addSourceRoot",
  "java.getProjectTree",
  "java.listMainClasses",
  "java.addRunConfiguration",
  "java.selectRunConfiguration",
  "java.build",
  "java.run",
  "java.stop",
  "java.debug.start",
  "java.debug.command",
  "java.check",
  "java.completeType",
  "java.completion",
  "java.definition",
  "java.references",
  "java.semanticTokens"
];
