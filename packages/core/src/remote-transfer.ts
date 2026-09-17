import { randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WebSocket } from "ws";
import { remoteTransferDefaultLimit, type RemoteTransferDirection, type RemoteTransferTicket } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

type Entry = { token: string; workspace: string; target: string; relative: string; direction: RemoteTransferDirection; size: number; maxBytes: number; overwrite: boolean; mode: number; expiresAt: number; socket?: WebSocket; partial?: string; cancelled: boolean };

export class RemoteTransferService {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxBytes = remoteTransferDefaultLimit, private readonly ttlMs = 60_000) {}

  async begin(workspace: string, input: { direction: RemoteTransferDirection; path: string; size?: number; overwrite?: boolean; mode?: number }): Promise<RemoteTransferTicket> {
    if (input.direction !== "upload" && input.direction !== "download") throw new CoreError("INVALID_REQUEST", "Transfer direction must be upload or download");
    const relative = normalizeRelative(input.path);
    const target = path.resolve(workspace, relative);
    await rejectSymlinkPath(workspace, target, input.direction === "upload");
    let size: number;
    if (input.direction === "download") {
      const info = await safeLstat(target, "The requested workspace file does not exist");
      if (!info.isFile() || info.isSymbolicLink()) throw new CoreError("INVALID_REQUEST", "Only regular, non-symlink workspace files can be downloaded");
      size = info.size;
    } else {
      if (!Number.isSafeInteger(input.size) || input.size! < 0) throw new CoreError("INVALID_REQUEST", "Upload size must be a non-negative integer");
      size = input.size!;
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new CoreError("INVALID_REQUEST", "Upload destination must be a regular file or a new path");
      if (existing && !input.overwrite) throw new CoreError("INVALID_REQUEST", "A workspace file already exists at that destination; explicitly allow overwrite");
    }
    if (size > this.maxBytes) throw new CoreError("INVALID_REQUEST", `Transfer exceeds the ${formatBytes(this.maxBytes)} limit`);
    const mode = input.mode === undefined ? 0o644 : input.mode;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o700) === 0) throw new CoreError("INVALID_REQUEST", "File permissions must be an owner-accessible mode between 000 and 777");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.entries.set(token, { token, workspace: path.resolve(workspace), target, relative, direction: input.direction, size, maxBytes: this.maxBytes, overwrite: Boolean(input.overwrite), mode, expiresAt, cancelled: false });
    return { token, direction: input.direction, name: path.basename(relative), size, maxBytes: this.maxBytes, expiresAt: new Date(expiresAt).toISOString() };
  }

  cancel(token: string): boolean { const entry = this.entries.get(token); if (!entry) return false; entry.cancelled = true; entry.socket?.close(4000, "Transfer cancelled"); void this.cleanup(entry); this.entries.delete(token); return true; }
  hasWorkspace(workspace: string): boolean { const target = path.resolve(workspace); return [...this.entries.values()].some((entry) => entry.workspace === target); }
  accepts(url: string | undefined): boolean { return Boolean(url?.startsWith("/project-transfer?")); }
  async attach(socket: WebSocket, requestUrl: string | undefined): Promise<void> {
    const token = new URL(requestUrl ?? "", "ws://core").searchParams.get("token") ?? "";
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt < Date.now() || entry.socket) { socket.close(1008, "Invalid or expired transfer ticket"); return; }
    entry.socket = socket;
    if (entry.direction === "download") return this.download(entry, socket);
    await this.upload(entry, socket);
  }
  private async download(entry: Entry, socket: WebSocket): Promise<void> {
    let handle;
    try {
      handle = await open(entry.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const current = await handle.stat();
      if (!current.isFile() || current.size !== entry.size) throw new Error("Workspace file changed after the transfer was approved");
    } catch {
      await handle?.close(); this.entries.delete(entry.token); socket.close(1008, "Workspace file changed; start the download again"); return;
    }
    const stream = createReadStream(entry.target, { fd: handle.fd, autoClose: true });
    const abort = () => stream.destroy(new Error("Transfer cancelled"));
    socket.once("close", abort);
    stream.on("data", (chunk) => {
      stream.pause();
      if (socket.readyState !== socket.OPEN) { stream.destroy(new Error("Transfer interrupted")); return; }
      socket.send(chunk, { binary: true }, (error) => error ? stream.destroy(error) : stream.resume());
    });
    stream.once("error", () => { this.entries.delete(entry.token); if (socket.readyState === socket.OPEN) socket.close(1011, "Could not read workspace file"); });
    stream.once("end", () => { this.entries.delete(entry.token); socket.off("close", abort); if (socket.readyState === socket.OPEN) socket.close(1000, "Transfer complete"); });
    socket.once("close", () => this.entries.delete(entry.token));
  }
  private async upload(entry: Entry, socket: WebSocket): Promise<void> {
    await mkdir(path.dirname(entry.target), { recursive: true });
    await rejectSymlinkPath(entry.workspace, entry.target, true);
    entry.partial = path.join(path.dirname(entry.target), `.${path.basename(entry.target)}.vibe-part-${randomBytes(8).toString("hex")}`);
    const file = createWriteStream(entry.partial, { flags: "wx", mode: 0o600 });
    let received = 0; let settled = false;
    const fail = async (reason: string) => { if (settled) return; settled = true; file.destroy(); await this.cleanup(entry); if (socket.readyState === socket.OPEN) socket.close(1009, reason); };
    const commit = async () => {
      if (settled) return;
      if (received !== entry.size) { await fail("Upload ended before the approved size was received"); return; }
      settled = true;
      try {
        await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()));
        await rejectSymlinkPath(entry.workspace, entry.target, true);
        await chmod(entry.partial!, entry.mode);
        if (entry.overwrite) await rename(entry.partial!, entry.target);
        else { await link(entry.partial!, entry.target); await rm(entry.partial!); }
        entry.partial = undefined; this.entries.delete(entry.token);
        if (socket.readyState === socket.OPEN) socket.close(1000, "Transfer complete");
      } catch (error) {
        await this.cleanup(entry); this.entries.delete(entry.token);
        if (socket.readyState === socket.OPEN) socket.close(1008, (error as NodeJS.ErrnoException).code === "EEXIST" ? "A workspace file appeared at the destination; upload was not applied" : "Could not commit uploaded file");
      }
    };
    socket.on("message", (data, binary) => {
      if (!binary || entry.cancelled) { void fail(entry.cancelled ? "Transfer cancelled" : "Only binary file data is accepted"); return; }
      const chunk = rawDataBuffer(data);
      if (chunk.length === 0) { void commit(); return; }
      received += chunk.length;
      if (received > entry.size || received > entry.maxBytes) { void fail("Transfer size limit exceeded"); return; }
      if (!file.write(chunk)) socket.pause();
    });
    file.on("drain", () => socket.resume());
    socket.once("error", () => { if (!settled) void fail("Transfer interrupted"); });
    socket.on("close", async (code) => {
      this.entries.delete(entry.token);
      if (settled) return;
      await fail(code === 4000 ? "Transfer cancelled" : "Transfer interrupted");
    });
  }
  private async cleanup(entry: Entry): Promise<void> { if (entry.partial) await rm(entry.partial, { force: true }).catch(() => undefined); }
}

function normalizeRelative(value: string): string { if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value)) throw new CoreError("INVALID_REQUEST", "Choose a destination inside the current workspace"); const normalized = path.normalize(value); if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new CoreError("INVALID_REQUEST", "Workspace path traversal is not allowed"); return normalized; }
async function rejectSymlinkPath(workspace: string, target: string, allowMissingLeaf: boolean): Promise<void> { const root = path.resolve(workspace); if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new CoreError("INVALID_REQUEST", "Destination is outside the current workspace"); const parts = path.relative(root, target).split(path.sep).filter(Boolean); let current = root; for (let index = 0; index < parts.length; index++) { current = path.join(current, parts[index]!); const info = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)); if (!info) { if (allowMissingLeaf) return; throw new CoreError("INVALID_REQUEST", "The requested workspace file does not exist"); } if (info.isSymbolicLink()) throw new CoreError("INVALID_REQUEST", "Transfers through workspace symlinks are not allowed"); if (index < parts.length - 1 && !info.isDirectory()) throw new CoreError("INVALID_REQUEST", "A parent of the transfer destination is not a directory"); } }
async function safeLstat(target: string, message: string) { try { return await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("INVALID_REQUEST", message); throw error; } }
function formatBytes(bytes: number): string { return `${Math.floor(bytes / (1024 * 1024))} MiB`; }
function rawDataBuffer(data: import("ws").RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data); }
