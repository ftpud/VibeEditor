/**
 * Core services can be reached from both the Desktop websocket and MCP stdio
 * processes. Keep root Git mutations in one process-wide queue so an
 * integration candidate cannot race a user-initiated merge.
 */
import path from "node:path";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { retryProcessSpawn } from "./process-spawn.js";

const queues = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);

export async function serializedRootMutation<T>(workspace: string, operation: () => Promise<T>, fallbackDirectory?: string): Promise<T> {
  return serializedMutation(path.resolve(workspace), () => acquireRepositoryLock(workspace, fallbackDirectory), operation);
}

/** Serialize mutations of one durable state file across this process and other Core processes. */
export async function serializedStateMutation<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const absoluteFile = path.resolve(file);
  return serializedMutation(`statefile:${absoluteFile}`, async () => {
    const lock = `${absoluteFile}.lock`;
    await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    return acquireStateFileLock(lock);
  }, operation);
}

async function serializedMutation<T>(
  key: string,
  acquire: () => Promise<string>,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  queues.set(key, queued);
  await previous.catch(() => undefined);
  let lock: string | undefined;
  try {
    lock = await acquire();
    return await operation();
  } finally {
    if (lock) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

type LockOwner = { pid: number; hostname: string; token: string };
const LOCK_WAIT_MS = 30_000;

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  return readOwnerFile(path.join(lock, "owner.json"));
}

async function readOwnerFile(file: string): Promise<LockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === "string" && typeof owner.token === "string") return owner;
  } catch { /* Unknown ownership must never be treated as a dead process. */ }
  return undefined;
}

function isDead(owner: LockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Publish complete ownership atomically; SIGKILL cannot leave a half-created lock. */
async function acquireStateFileLock(lock: string): Promise<string> {
  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), token: randomUUID() };
  const candidate = `${lock}.${owner.pid}.${owner.token}.tmp`;
  const started = Date.now();
  try {
    await writeFile(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    for (;;) {
      try { await link(candidate, lock); return lock; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const conflicting = await readOwnerFile(lock);
      if (conflicting && isDead(conflicting)) {
        const recovery = `${lock}.recovery`;
        let recovering = false;
        try {
          await mkdir(recovery, { mode: 0o700 });
          recovering = true;
          const current = await readOwnerFile(lock);
          if (current?.token === conflicting.token && isDead(current)) { await unlink(lock); continue; }
        } catch (error) {
          if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        } finally {
          if (recovering) await rm(recovery, { recursive: true, force: true });
        }
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        const detail = conflicting ? `PID ${conflicting.pid} on ${conflicting.hostname}` : "an unknown owner (inspect the lock before removing it)";
        throw new CoreError("WRITE_FAILED", `State file is locked by ${detail}: ${lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally { await unlink(candidate).catch(() => undefined); }
}

async function acquireRepositoryLock(workspace: string, fallbackDirectory?: string): Promise<string> {
  let directory: string;
  try {
    const { stdout } = await retryProcessSpawn(() => execFileAsync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }));
    directory = path.resolve(workspace, stdout.trim());
  } catch (error) {
    if (!fallbackDirectory || !(error as { stderr?: string }).stderr?.includes("not a git repository")) throw error;
    directory = fallbackDirectory;
    await mkdir(directory, { recursive: true });
  }
  const lock = path.join(directory, "vibe-editor-root-mutation.lock");
  return acquireOwnedLock(lock, "Repository", "GIT_FAILED");
}

async function acquireOwnedLock(lock: string, label: string, errorCode: "GIT_FAILED" | "WRITE_FAILED"): Promise<string> {
  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), token: randomUUID() };
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      try { await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx" }); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const conflicting = await readOwner(lock);
    if (conflicting && isDead(conflicting)) {
      // Only one contender may reclaim this directory. Others wait until the
      // reclaim finishes; they must never remove a newly acquired live lock.
      const recovery = path.join(lock, "recovery");
      try {
        await mkdir(recovery);
        const current = await readOwner(lock);
        if (current?.token === conflicting.token && isDead(current)) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        await rm(recovery, { recursive: true, force: true });
      } catch (error) {
        if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (Date.now() - started >= LOCK_WAIT_MS) {
      const detail = conflicting ? `PID ${conflicting.pid} on ${conflicting.hostname}` : "an unknown owner (inspect the lock before removing it)";
      throw new CoreError(errorCode, `${label} is locked by ${detail}: ${lock}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
