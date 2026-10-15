import path from "node:path";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";

export type StorageProcess = { pid: number; parentPid: number; birth: string; argv: string[]; cwd: string; executable: string; core: boolean };
type ProcessAccess = { snapshot(): Promise<StorageProcess[]>; signal(row: StorageProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void>; pause(): Promise<void>; now(): number; self: number };
const inside = (file: string, directory: string) => file === directory || file.startsWith(`${directory}${path.sep}`);

/** Only same-account Vibe Core processes, their descendants, and obsolete runtime executables are stopped. */
export class StorageProcesses {
  constructor(private readonly access: ProcessAccess = {
    snapshot: storageProcessSnapshot, signal: signalStorageProcess,
    pause: () => new Promise((resolve) => setTimeout(resolve, 100)), now: Date.now, self: process.pid
  }) {}
  async closeOtherSessions(removing: string[], progress: (message: string) => void): Promise<void> {
    let rows = await this.access.snapshot();
    const protectedPids = new Set<number>([this.access.self]);
    let ancestor = rows.find((row) => row.pid === this.access.self)?.parentPid;
    while (ancestor && !protectedPids.has(ancestor)) { protectedPids.add(ancestor); ancestor = rows.find((row) => row.pid === ancestor)?.parentPid; }
    const targets = new Map<number, StorageProcess>();
    for (const row of rows) if (row.core && !protectedPids.has(row.pid)) targets.set(row.pid, row);
    const descendants = new Map(targets);
    const collect = (snapshot: StorageProcess[]) => {
      let added = true;
      while (added) {
        added = false;
        for (const row of snapshot) {
          if (protectedPids.has(row.pid) || descendants.has(row.pid)) continue;
          const runtimeWorker = removing.some((directory) => inside(row.executable, directory) && /\/node_modules\/@openai\/codex/.test(row.executable) || row.argv.slice(1).some((arg) => path.isAbsolute(arg) && inside(arg, directory) && /\/node_modules\/@(?:agentclientprotocol\/codex-acp|openai\/codex)\//.test(arg)));
          if (descendants.has(row.parentPid) || runtimeWorker) { descendants.set(row.pid, row); added = true; }
        }
      }
    };
    collect(rows);
    progress(`Stopping ${targets.size} other Vibe servers for this SSH account…`);
    for (const row of targets.values()) await this.access.signal(row, "SIGTERM");
    const deadline = this.access.now() + 35_000;
    const alive = (row: StorageProcess) => rows.some((current) => current.pid === row.pid && current.birth === row.birth);
    while ([...targets.values()].some(alive) && this.access.now() < deadline) { await this.access.pause(); rows = await this.access.snapshot(); collect(rows); }
    progress("Closing agents and terminals belonging to stopped Vibe servers…");
    for (const row of descendants.values()) if (alive(row)) await this.access.signal(row, "SIGTERM");
    const childDeadline = this.access.now() + 3_000;
    while ([...descendants.values()].some(alive) && this.access.now() < childDeadline) { await this.access.pause(); rows = await this.access.snapshot(); collect(rows); }
    for (const row of descendants.values()) if (alive(row)) await this.access.signal(row, "SIGKILL");
    await this.access.pause(); rows = await this.access.snapshot();
    if ([...descendants.values()].some(alive)) throw new Error("A Vibe session did not stop; obsolete versions have been preserved");
    if (rows.some((row) => row.core && !protectedPids.has(row.pid))) throw new Error("Another Vibe server started during maintenance; versions have been preserved. Retry after it stops");
    for (const row of rows) if (removing.some((directory) => inside(row.cwd, directory) || inside(row.executable, directory) || row.argv.some((arg) => path.isAbsolute(arg) && inside(arg, directory)))) throw new Error(`PID ${row.pid} is still using an obsolete version; its files have been preserved`);
  }
}

export async function storageProcessSnapshot(): Promise<StorageProcess[]> {
  if (process.platform !== "linux") throw new Error("Closing Vibe sessions across this account currently requires a Linux server");
  const rows: StorageProcess[] = [];
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  for (let start = 0; start < names.length; start += 32) {
    const batch = await Promise.all(names.slice(start, start + 32).map(async (name): Promise<StorageProcess | undefined> => {
      try {
        if ((await lstat(`/proc/${name}`)).uid !== process.getuid!()) return;
        const stat = await readFile(`/proc/${name}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (!fields[19] || fields[0] === "Z") return;
        const argv = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").filter(Boolean);
        if (!argv.length) return;
        const cwd = await readlink(`/proc/${name}/cwd`).catch(() => "");
        const executable = await readlink(`/proc/${name}/exe`).catch(() => "");
        let core = false;
        for (const arg of argv.slice(1)) {
          if (!/(?:^|\/)packages\/core\/(?:dist\/index\.js|src\/index\.ts)$/.test(arg)) continue;
          if (!cwd && !path.isAbsolute(arg)) throw new Error("Cannot verify a Vibe server's working directory");
          const script = path.resolve(cwd, arg);
          const manifest = await readFile(path.resolve(path.dirname(script), "..", "package.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);
          if (manifest?.name === "@remote-ide/core" && argv.includes("--workspace")) core = true;
        }
        return { pid: Number(name), parentPid: Number(fields[1]), birth: fields[19], argv, cwd, executable, core };
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return;
      }
    }));
    for (const row of batch) if (row) rows.push(row);
  }
  return rows;
}
async function signalStorageProcess(row: StorageProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  try {
    const meta = await lstat(`/proc/${row.pid}`);
    const stat = await readFile(`/proc/${row.pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const argv = (await readFile(`/proc/${row.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    if (meta.uid !== process.getuid!() || fields[19] !== row.birth || fields[0] === "Z" || JSON.stringify(argv) !== JSON.stringify(row.argv)) return;
    process.kill(row.pid, signal);
  } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
