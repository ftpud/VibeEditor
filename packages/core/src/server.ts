import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import chokidar from "chokidar";
import path from "node:path";
import { requestTypes, type FileChangeKind, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { PtyProcessManager } from "./process-manager.js";
import { GitService } from "./git.js";

export async function createServer(host: string, port: number, workspacePath: string): Promise<WebSocketServer> {
  const validation = new WorkspaceFileSystem();
  await validation.open(workspacePath);
  const workspace = validation.getWorkspace();
  const watcher = chokidar.watch(workspace, {
    ignoreInitial: true,
    ignored: (watchPath) => path.relative(workspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });
  const server = new WebSocketServer({ host, port });
  const activeSessions = new Set<WebSocket>();
  const gitIndexWatcher = chokidar.watch(path.join(workspace, ".git", "index"), { ignoreInitial: true });
  gitIndexWatcher.on("change", () => {
    const encoded = JSON.stringify({ type: "git.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  });
  const broadcastChange = (kind: FileChangeKind, absolutePath: string) => {
    const relativePath = absolutePath.slice(workspace.length + 1).split("\\").join("/");
    if (!relativePath) return;
    const event: ServerEvent = { type: "filesystem.changed", payload: { path: relativePath, kind } };
    const encoded = JSON.stringify(event);
    for (const socket of activeSessions) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
    console.log(`[core] filesystem ${kind}: ${relativePath}`);
  };
  watcher
    .on("add", (file) => broadcastChange("add", file))
    .on("change", (file) => broadcastChange("change", file))
    .on("unlink", (file) => broadcastChange("unlink", file))
    .on("addDir", (directory) => broadcastChange("addDir", directory))
    .on("unlinkDir", (directory) => broadcastChange("unlinkDir", directory))
    .on("error", (error) => console.error(`[core] watcher error: ${String(error)}`));
  server.on("close", () => { void watcher.close(); void gitIndexWatcher.close(); });
  server.on("listening", () => console.log(`[core] listening on ws://${host}:${port}`));
  server.on("connection", (socket, request) => {
    const filesystem = new WorkspaceFileSystem();
    const git = new GitService(workspace);
    const processManager = new PtyProcessManager(workspace, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const message: ServerEvent = event.type === "output"
        ? { type: "terminal.output", payload: { terminalId: event.terminalId, data: event.data } }
        : { type: "terminal.exit", payload: { terminalId: event.terminalId, exitCode: event.exitCode } };
      socket.send(JSON.stringify(message));
    });
    const client = request.socket.remoteAddress ?? "unknown";
    console.log(`[core] connected: ${client}`);
    socket.on("message", async (data) => {
      let id = "unknown";
      try {
        const parsed = parseRequest(data);
        id = parsed.id;
        console.log(`[core] request ${parsed.id}: ${parsed.type}`);
        const result = await handleRequest(filesystem, processManager, git, workspacePath, parsed);
        if (parsed.type === "workspace.open") activeSessions.add(socket);
        socket.send(JSON.stringify({ id, ok: true, result }));
      } catch (error) {
        const coreError = error instanceof CoreError ? error : new CoreError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
        console.error(`[core] error ${id}: ${coreError.code} ${coreError.message}`);
        socket.send(JSON.stringify({ id, ok: false, error: { code: coreError.code, message: coreError.message } } satisfies Response));
      }
    });
    socket.on("close", () => {
      activeSessions.delete(socket);
      processManager.closeAll();
      console.log(`[core] disconnected: ${client}`);
    });
    socket.on("error", (error) => console.error(`[core] socket error: ${error.message}`));
  });
  return server;
}

function parseRequest(data: RawData): Request {
  let value: unknown;
  try { value = JSON.parse(data.toString()); } catch { throw new CoreError("INVALID_REQUEST", "Message must be valid JSON"); }
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Request must be an object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string" || !("payload" in candidate) || !requestTypes.includes(candidate.type as RequestType)) {
    throw new CoreError("INVALID_REQUEST", "Request must contain a valid id, type, and payload");
  }
  return value as Request;
}

async function handleRequest(filesystem: WorkspaceFileSystem, processManager: PtyProcessManager, git: GitService, workspacePath: string, request: Request): Promise<unknown> {
  if (request.type !== "workspace.open") filesystem.getWorkspace();
  switch (request.type) {
    case "workspace.open": {
      const tree = await filesystem.open(workspacePath);
      return { workspace: filesystem.getWorkspace(), tree };
    }
    case "filesystem.listTree": return { tree: await filesystem.listTree() };
    case "filesystem.readFile": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return { path: request.payload.path, content: await filesystem.read(request.payload.path) };
    }
    case "filesystem.writeFile": {
      if (typeof request.payload.path !== "string" || typeof request.payload.content !== "string") throw new CoreError("INVALID_REQUEST", "path and content must be strings");
      return { path: request.payload.path, bytesWritten: await filesystem.write(request.payload.path, request.payload.content) };
    }
    case "terminal.create": {
      return { terminalId: processManager.create(request.payload.cols, request.payload.rows) };
    }
    case "terminal.input": {
      if (typeof request.payload.terminalId !== "string" || typeof request.payload.data !== "string") throw new CoreError("INVALID_REQUEST", "terminalId and data must be strings");
      processManager.input(request.payload.terminalId, request.payload.data);
      return {};
    }
    case "terminal.resize": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      processManager.resize(request.payload.terminalId, request.payload.cols, request.payload.rows);
      return {};
    }
    case "terminal.close": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      processManager.close(request.payload.terminalId);
      return {};
    }
    case "git.status": return git.status();
  }
}
