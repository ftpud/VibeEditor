import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import WebSocket from "ws";

type LocalChoice = { id: string; name: string; size?: number };
const choices = new Map<string, { path: string; direction: "upload" | "download" }>();
const active = new Map<string, WebSocket>();

export function registerProjectTransferIpc(): void {
  ipcMain.handle("project-transfer:choose-upload", async (event): Promise<LocalChoice | undefined> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner ? await dialog.showOpenDialog(owner, { title: "Upload to workspace", properties: ["openFile"] }) : await dialog.showOpenDialog({ title: "Upload to workspace", properties: ["openFile"] });
    const localPath = result.filePaths[0]; if (result.canceled || !localPath) return;
    const info = await lstat(localPath); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Choose a regular, non-symlink local file");
    const id = randomUUID(); choices.set(id, { path: localPath, direction: "upload" }); return { id, name: path.basename(localPath), size: info.size };
  });
  ipcMain.handle("project-transfer:choose-download", async (event, suggestedName: unknown): Promise<LocalChoice | undefined> => {
    if (typeof suggestedName !== "string" || !suggestedName || suggestedName.length > 255) throw new Error("Invalid download name");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner ? await dialog.showSaveDialog(owner, { title: "Save workspace file", defaultPath: suggestedName }) : await dialog.showSaveDialog({ title: "Save workspace file", defaultPath: suggestedName });
    if (result.canceled || !result.filePath) return;
    const id = randomUUID(); choices.set(id, { path: result.filePath, direction: "download" }); return { id, name: path.basename(result.filePath) };
  });
  ipcMain.handle("project-transfer:start", async (event, value: unknown) => {
    const input = validateStart(value); const choice = choices.get(input.localId);
    if (!choice || choice.direction !== input.direction) throw new Error("The local file choice expired; choose the file again");
    choices.delete(input.localId);
    const operationId = randomUUID();
    void runTransfer(choice.path, input, operationId, (bytes) => event.sender.send("project-transfer:progress", { operationId, bytes, total: input.size }))
      .then(() => event.sender.send("project-transfer:progress", { operationId, bytes: input.size, total: input.size, done: true }))
      .catch((error: unknown) => event.sender.send("project-transfer:progress", { operationId, bytes: 0, total: input.size, error: error instanceof Error ? error.message : "Transfer failed" }));
    return { operationId };
  });
  ipcMain.handle("project-transfer:cancel", (_event, operationId: unknown) => { if (typeof operationId !== "string") return false; const socket = active.get(operationId); socket?.close(4000, "Transfer cancelled"); return Boolean(socket); });
}

export function validateStart(value: unknown): { localId: string; token: string; host: string; port: number; direction: "upload" | "download"; size: number } {
  if (!value || typeof value !== "object") throw new Error("Invalid transfer request"); const item = value as Record<string, unknown>;
  if (typeof item.localId !== "string" || typeof item.token !== "string" || typeof item.host !== "string" || !Number.isInteger(item.port) || (item.direction !== "upload" && item.direction !== "download") || !Number.isSafeInteger(item.size) || (item.size as number) < 0) throw new Error("Invalid transfer request");
  return item as ReturnType<typeof validateStart>;
}

async function runTransfer(localPath: string, input: ReturnType<typeof validateStart>, operationId: string, progress: (bytes: number) => void): Promise<void> {
  const socket = new WebSocket(`ws://${encodeHost(input.host)}:${input.port}/project-transfer?token=${encodeURIComponent(input.token)}`); active.set(operationId, socket);
  try { input.direction === "upload" ? await upload(socket, localPath, input.size, progress) : await download(socket, localPath, input.size, progress); }
  finally { active.delete(operationId); }
}
function upload(socket: WebSocket, localPath: string, expected: number, progress: (bytes: number) => void): Promise<void> { return new Promise((resolve, reject) => { let sent = 0; const stream = createReadStream(localPath); socket.once("open", () => stream.on("data", (chunk) => { stream.pause(); socket.send(chunk, { binary: true }, (error) => { if (error) return stream.destroy(error); sent += chunk.length; progress(sent); stream.resume(); }); }).once("end", () => socket.close(1000, "Transfer complete"))); socket.once("close", (code, reason) => { stream.destroy(); code === 1000 && sent === expected ? resolve() : reject(new Error(safeTransferError(code, reason.toString()))); }); socket.once("error", reject); }); }
function download(socket: WebSocket, localPath: string, expected: number, progress: (bytes: number) => void): Promise<void> { return new Promise((resolve, reject) => { const partial = `${localPath}.vibe-part-${randomUUID()}`; const file = createWriteStream(partial, { flags: "wx", mode: 0o600 }); let received = 0; let failed = false; const cleanup = (error: Error) => { if (failed) return; failed = true; file.destroy(); void rm(partial, { force: true }).finally(() => reject(error)); }; socket.on("message", (data, binary) => { const chunk = rawDataBuffer(data); if (!binary || received + chunk.length > expected) return cleanup(new Error("Core sent invalid transfer data")); received += chunk.length; file.write(chunk); progress(received); }); socket.once("close", (code, reason) => { if (failed) return; if (code !== 1000 || received !== expected) return cleanup(new Error(safeTransferError(code, reason.toString()))); file.end(() => void rename(partial, localPath).then(resolve, cleanup)); }); socket.once("error", (error) => cleanup(error)); }); }
function rawDataBuffer(data: import("ws").RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data); }
export function encodeHost(host: string): string { if (!host || host.includes("/") || host.includes("@")) throw new Error("Invalid Core host"); return host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host; }
export function safeTransferError(code: number, reason: string): string { if (code === 4000) return "Transfer cancelled"; if (code === 1009) return reason || "Transfer size limit exceeded"; return reason && reason.length < 160 ? reason : "Transfer interrupted; no partial file was kept"; }
