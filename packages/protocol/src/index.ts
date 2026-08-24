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

export type WorkspaceOptions = {
  openFiles: string[];
  activeFile?: string;
  javaProject?: JavaProjectOptions;
};

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
    result: { workspace: string; tree: FileTreeNode[]; options: WorkspaceOptions };
  };
  "workspace.saveOptions": {
    payload: { options: WorkspaceOptions };
    result: Record<string, never>;
  };
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
    result: { path: string; originalContent: string; modifiedContent: string };
  };
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

export type ServerEvent = FilesystemChangedEvent | TerminalOutputEvent | TerminalExitEvent | GitChangedEvent | JavaOutputEvent | JavaExitEvent;

export const requestTypes: RequestType[] = [
  "workspace.open",
  "workspace.saveOptions",
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
  "java.loadMavenProject",
  "java.getOptions",
  "java.addSourceRoot",
  "java.getProjectTree",
  "java.listMainClasses",
  "java.addRunConfiguration",
  "java.selectRunConfiguration",
  "java.build",
  "java.run",
  "java.stop"
];
