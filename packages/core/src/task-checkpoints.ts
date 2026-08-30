import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { AiProvider, TaskCheckpoint, TaskCheckpointFile } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const execFileAsync = promisify(execFile);
type SnapshotEntry = { hash: string; size: number; mode: number; symlink?: boolean; binary: boolean };
type StoredCheckpoint = Omit<TaskCheckpoint, "files"> & { before: Record<string, SnapshotEntry>; after?: Record<string, SnapshotEntry> };

/** Durable, Git-independent prompt snapshots. Blobs and manifests live in Core state, never in .git. */
export class TaskCheckpointStore {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    this.root = path.join(stateDirectory, `${crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex")}-task-history`);
  }

  begin(provider: AiProvider, prompt: string, sessionId?: string, promptId: string = crypto.randomUUID()): Promise<string> {
    return this.serial(async () => {
      const id = crypto.randomUUID();
      const checkpoint: StoredCheckpoint = { id, promptId, provider, prompt: prompt.slice(0, 100_000), startedAt: new Date().toISOString(), status: "running", before: await this.capture(), ...(sessionId ? { sessionId } : {}) };
      await this.write(checkpoint); await this.prune(); return id;
    });
  }

  complete(id: string, status: "completed" | "interrupted" | "error"): Promise<void> {
    return this.serial(async () => {
      const checkpoint = await this.read(id);
      if (checkpoint.status !== "running") return;
      checkpoint.after = await this.capture(); checkpoint.status = status; checkpoint.completedAt = new Date().toISOString();
      await this.write(checkpoint);
    });
  }

  /** A Core restart cannot resume an in-flight turn observer; close those points at startup. */
  recover(): Promise<void> {
    return this.serial(async () => {
      const running = (await this.all()).filter((item) => item.status === "running"); if (running.length === 0) return;
      const after = await this.capture();
      for (const item of running) { item.after = after; item.status = "interrupted"; item.completedAt = new Date().toISOString(); await this.write(item); }
      await this.prune();
    });
  }

  async history(): Promise<TaskCheckpoint[]> {
    const checkpoints = await this.all();
    return checkpoints.map((item) => ({ id: item.id, promptId: item.promptId, provider: item.provider, prompt: item.prompt, startedAt: item.startedAt, status: item.status, ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), files: changes(item.before, item.after ?? item.before) }));
  }

  async diff(id: string, filePath: string): Promise<{ originalContent: string; modifiedContent: string; binary: boolean }> {
    validatePath(filePath); const item = await this.read(id); const after = item.after ?? item.before;
    const change = changes(item.before, after).find((entry) => entry.path === filePath);
    if (!change) throw new CoreError("INVALID_REQUEST", "File is not part of that checkpoint");
    const beforeEntry = item.before[change.originalPath ?? filePath]; const afterEntry = after[filePath];
    const binary = Boolean(beforeEntry?.binary || afterEntry?.binary);
    return { originalContent: binary || !beforeEntry ? "" : (await this.blob(beforeEntry.hash)).toString("utf8"), modifiedContent: binary || !afterEntry ? "" : (await this.blob(afterEntry.hash)).toString("utf8"), binary };
  }

  restore(id: string): Promise<string[]> {
    return this.serial(async () => {
      const item = await this.read(id); if (!item.after) throw new CoreError("INVALID_REQUEST", "A running checkpoint cannot be restored");
      const current = await this.managedPaths(); const target = item.after;
      for (const file of current) if (!target[file]) await rm(this.target(file), { force: true, recursive: true });
      for (const [file, entry] of Object.entries(target)) {
        const destination = this.target(file); await mkdir(path.dirname(destination), { recursive: true }); await rm(destination, { force: true, recursive: true });
        const content = await this.blob(entry.hash);
        if (entry.symlink) await symlink(content.toString("utf8"), destination); else { await writeFile(destination, content); await chmod(destination, entry.mode & 0o777); }
      }
      return [...new Set([...current, ...Object.keys(target)])].sort();
    });
  }

  private async capture(): Promise<Record<string, SnapshotEntry>> {
    const result: Record<string, SnapshotEntry> = {};
    for (const file of await this.managedPaths()) {
      try {
        const full = this.target(file); const stat = await lstat(full); if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        const content = stat.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full); const hash = crypto.createHash("sha256").update(content).digest("hex");
        await mkdir(path.join(this.root, "blobs"), { recursive: true }); await writeFile(path.join(this.root, "blobs", hash), content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        result[file] = { hash, size: content.length, mode: stat.mode, ...(stat.isSymbolicLink() ? { symlink: true } : {}), binary: content.includes(0) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return result;
  }

  private async managedPaths(): Promise<string[]> {
    try { return (await execFileAsync("git", ["-C", this.workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout.split("\0").filter(Boolean); }
    catch (error) { throw new CoreError("GIT_FAILED", `Could not enumerate task files: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private target(file: string): string { validatePath(file); const target = path.resolve(this.workspace, file); if (!target.startsWith(`${path.resolve(this.workspace)}${path.sep}`)) throw new CoreError("INVALID_REQUEST", "Invalid checkpoint path"); return target; }
  private blob(hash: string): Promise<Buffer> { return readFile(path.join(this.root, "blobs", hash)); }
  private file(id: string): string { if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CoreError("INVALID_REQUEST", "Invalid checkpoint id"); return path.join(this.root, "checkpoints", `${id}.json`); }
  private async read(id: string): Promise<StoredCheckpoint> { try { return JSON.parse(await readFile(this.file(id), "utf8")) as StoredCheckpoint; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("INVALID_REQUEST", "Checkpoint no longer exists"); throw error; } }
  private async write(value: StoredCheckpoint): Promise<void> { await mkdir(path.join(this.root, "checkpoints"), { recursive: true }); await writeFile(this.file(value.id), JSON.stringify(value), "utf8"); }
  private async all(): Promise<StoredCheckpoint[]> { try { const files = (await readdir(path.join(this.root, "checkpoints"))).filter((file) => file.endsWith(".json")); return (await Promise.all(files.map((file) => this.read(file.slice(0, -5))))).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error); } }
  private async prune(): Promise<void> {
    const all = await this.all(); const keep = new Set([...all.filter((item) => item.status === "running"), ...all.filter((item) => item.status !== "running").slice(0, 100)].map((item) => item.id));
    for (const item of all) if (!keep.has(item.id)) await rm(this.file(item.id), { force: true });
    const retained = all.filter((item) => keep.has(item.id)); const hashes = new Set(retained.flatMap((item) => [...Object.values(item.before), ...Object.values(item.after ?? {})].map((entry) => entry.hash)));
    try { for (const blob of await readdir(path.join(this.root, "blobs"))) if (!hashes.has(blob)) await rm(path.join(this.root, "blobs", blob), { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next; }
}

function changes(before: Record<string, SnapshotEntry>, after: Record<string, SnapshotEntry>): TaskCheckpointFile[] {
  const deleted = Object.entries(before).filter(([file, entry]) => !after[file] && entry); const added = Object.entries(after).filter(([file]) => !before[file]); const result: TaskCheckpointFile[] = [];
  const used = new Set<string>();
  for (const [oldPath, oldEntry] of deleted) { const renamed = added.find(([newPath, entry]) => !used.has(newPath) && entry.hash === oldEntry.hash); if (renamed) { used.add(renamed[0]); result.push({ path: renamed[0], originalPath: oldPath, status: "R", binary: oldEntry.binary, size: oldEntry.size }); } else result.push({ path: oldPath, status: "D", binary: oldEntry.binary, size: oldEntry.size }); }
  for (const [file, entry] of added) if (!used.has(file)) result.push({ path: file, status: "A", binary: entry.binary, size: entry.size });
  for (const [file, entry] of Object.entries(after)) if (before[file] && (before[file]!.hash !== entry.hash || before[file]!.mode !== entry.mode)) result.push({ path: file, status: "M", binary: entry.binary || before[file]!.binary, size: entry.size });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function validatePath(file: string): void { if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new CoreError("INVALID_REQUEST", "Invalid checkpoint path"); }
