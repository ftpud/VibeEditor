export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type ProtocolOperations = {
  "workspace.open": {
    payload: Record<string, never>;
    result: { workspace: string; tree: FileTreeNode[] };
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
  | "TERMINAL_FAILED";

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

export type ServerEvent = FilesystemChangedEvent | TerminalOutputEvent | TerminalExitEvent;

export const requestTypes: RequestType[] = [
  "workspace.open",
  "filesystem.listTree",
  "filesystem.readFile",
  "filesystem.writeFile",
  "terminal.create",
  "terminal.input",
  "terminal.resize",
  "terminal.close"
];
