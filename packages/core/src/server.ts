import type { RawData } from "ws";
import { WebSocketServer } from "ws";
import { requestTypes, type Request, type RequestType, type Response } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

export async function createServer(host: string, port: number, workspacePath: string): Promise<WebSocketServer> {
  const validation = new WorkspaceFileSystem();
  await validation.open(workspacePath);
  const server = new WebSocketServer({ host, port });
  server.on("listening", () => console.log(`[core] listening on ws://${host}:${port}`));
  server.on("connection", (socket, request) => {
    const filesystem = new WorkspaceFileSystem();
    const client = request.socket.remoteAddress ?? "unknown";
    console.log(`[core] connected: ${client}`);
    socket.on("message", async (data) => {
      let id = "unknown";
      try {
        const parsed = parseRequest(data);
        id = parsed.id;
        console.log(`[core] request ${parsed.id}: ${parsed.type}`);
        const result = await handleRequest(filesystem, workspacePath, parsed);
        socket.send(JSON.stringify({ id, ok: true, result }));
      } catch (error) {
        const coreError = error instanceof CoreError ? error : new CoreError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
        console.error(`[core] error ${id}: ${coreError.code} ${coreError.message}`);
        socket.send(JSON.stringify({ id, ok: false, error: { code: coreError.code, message: coreError.message } } satisfies Response));
      }
    });
    socket.on("close", () => console.log(`[core] disconnected: ${client}`));
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

async function handleRequest(filesystem: WorkspaceFileSystem, workspacePath: string, request: Request): Promise<unknown> {
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
  }
}
