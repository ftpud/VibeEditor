/**
 * Core services can be reached from both the Desktop websocket and MCP stdio
 * processes. Keep root Git mutations in one process-wide queue so an
 * integration candidate cannot race a user-initiated merge.
 */
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const queues = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);

export async function serializedRootMutation<T>(workspace: string, operation: () => Promise<T>, fallbackDirectory?: string): Promise<T> {
  const key = path.resolve(workspace);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  queues.set(key, queued);
  await previous.catch(() => undefined);
  let lock: string | undefined;
  try {
    lock = await acquireRepositoryLock(workspace, fallbackDirectory);
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
  try {
    const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === "string" && typeof owner.token === "string") return owner;
  } catch { /* Unknown ownership must never be treated as a dead process. */ }
  return undefined;
}

function isDead(owner: LockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function acquireRepositoryLock(workspace: string, fallbackDirectory?: string): Promise<string> {
  let directory: string;
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    directory = path.resolve(workspace, stdout.trim());
  } catch (error) {
    if (!fallbackDirectory || !(error as { stderr?: string }).stderr?.includes("not a git repository")) throw error;
    directory = fallbackDirectory;
    await mkdir(directory, { recursive: true });
  }
  const lock = path.join(directory, "vibe-editor-root-mutation.lock");
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
      throw new CoreError("GIT_FAILED", `Repository is locked by ${detail}: ${lock}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
