/**
 * Core services can be reached from both the Desktop websocket and MCP stdio
 * processes. Keep root Git mutations in one process-wide queue so an
 * integration candidate cannot race a user-initiated merge.
 */
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const queues = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);

export async function serializedRootMutation<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspace);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, previous.catch(() => undefined).then(() => gate));
  await previous.catch(() => undefined);
  let lock: string | undefined;
  try {
    lock = await acquireRepositoryLock(workspace);
    return await operation();
  } finally {
    if (lock) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    release();
  }
}

async function acquireRepositoryLock(workspace: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  const lock = path.join(path.resolve(workspace, stdout.trim()), "vibe-editor-root-mutation.lock");
  for (;;) {
    try { await mkdir(lock); return lock; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
