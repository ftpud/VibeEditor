import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { serializedStateMutation } from "./root-mutation.js";
import { StorageProcesses } from "./storage-processes.js";

export type VersionEntry = { path: string; label: string; current: boolean };
export type VersionOptions = { home: string; runtimeDirectory: string; currentDeployment?: () => string; currentRuntime?: () => string | undefined; closeOtherSessions?: (paths: string[], progress: (message: string) => void) => Promise<void> };
const releasePattern = /^[a-f0-9]{40,64}-node\d+(?:-repair-[a-zA-Z0-9]+|-bundle-[a-zA-Z0-9-]+)?$/;
const contains = (directory: string, file: string) => file === directory || file.startsWith(`${directory}${path.sep}`);
async function names(directory: string): Promise<string[]> { try { return await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function directory(file: string): Promise<boolean> { const meta = await lstat(file).catch(() => undefined); return !!meta?.isDirectory() && !meta.isSymbolicLink(); }
async function safe(file: string): Promise<void> {
  let cursor = path.resolve(file);
  while (cursor !== path.dirname(cursor)) { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Version cleanup refuses symbolic links"); cursor = path.dirname(cursor); }
}

export class StorageVersions {
  private readonly deployment: string;
  constructor(private readonly options: VersionOptions) { this.deployment = path.join(options.home, ".vibe-deploy"); }
  private currentDeployment(): string { return path.resolve(this.options.currentDeployment?.() ?? fileURLToPath(new URL("../../../", import.meta.url))); }
  private currentRuntime(): string | undefined { return this.options.currentRuntime?.(); /* The legacy Codex runtime cache is no longer selected; provider agents are managed installations. */ }
  get supported(): boolean { return process.platform === "linux" || !!this.options.closeOtherSessions; }
  async entries(): Promise<VersionEntry[]> {
    const entries: VersionEntry[] = []; const currentRuntime = this.currentRuntime(); const currentDeployment = this.currentDeployment();
    for (const name of await names(this.options.runtimeDirectory)) {
      const file = path.join(this.options.runtimeDirectory, name);
      if (/^installation-[A-Za-z0-9_-]+$/.test(name) && await directory(file)) entries.push({ path: file, label: `Agent runtime · ${name}`, current: currentRuntime === file });
    }
    for (const name of await names(path.join(this.deployment, "releases"))) {
      const file = path.join(this.deployment, "releases", name);
      if ((releasePattern.test(name) || /^(?:\.staging-[\w.-]+|\.bundle-\d+-\d+)$/.test(name)) && await directory(file)) entries.push({ path: file, label: `Core / Desktop · ${name}`, current: contains(file, currentDeployment) });
    }
    for (const name of await names(path.join(this.deployment, "sources"))) {
      const file = path.join(this.deployment, "sources", name);
      if (/^[a-f0-9]{64}$/.test(name) && await directory(file)) entries.push({ path: file, label: `Rebuildable source cache · ${name.slice(0, 12)}`, current: contains(file, currentDeployment) });
    }
    return entries;
  }
  async keepCurrent(preview: string[], roots: () => Promise<string[]>, progress: (message: string) => void): Promise<void> {
    if (!this.supported) throw new Error("Closing other Vibe sessions requires a Linux server");
    await serializedStateMutation(path.join(this.deployment, "maintenance"), () => serializedStateMutation(path.join(this.options.runtimeDirectory, "maintenance"), async () => {
      await safe(this.deployment); await safe(this.options.runtimeDirectory);
      const provisionLock = path.join(this.deployment, "provision.lock");
      try { await mkdir(provisionLock); } catch { throw new Error("Gateway is provisioning a release. Wait for it to finish, then retry"); }
      try {
        await writeFile(path.join(provisionLock, "owner"), `${process.pid}|${os.hostname()}|${crypto.randomUUID()}`);
        if ((await names(this.deployment)).some((name) => /^activate-.*\.lock$/.test(name))) throw new Error("Gateway activation is in progress; versions were preserved");
        const registered = await roots();
        const obsolete = (await this.entries()).filter((entry) => !entry.current && preview.includes(entry.path) && !registered.some((root) => contains(entry.path, root)));
        const paths = obsolete.map((entry) => entry.path);
        await (this.options.closeOtherSessions ?? ((paths, progress) => new StorageProcesses().closeOtherSessions(paths, progress)))(paths, progress);
        // Re-read selection after stopping peers. Never remove the current runtime or release.
        for (const entry of obsolete) {
          if ((await this.entries()).find((current) => current.path === entry.path)?.current) continue;
          if ((await roots()).some((root) => contains(entry.path, root))) continue;
          await safe(entry.path); progress(`Removing obsolete version: ${path.basename(entry.path)}`); await rm(entry.path, { recursive: true });
        }
        const current = this.currentRuntime(); const selection = path.join(this.options.runtimeDirectory, "current.json");
        if (current && path.dirname(current) === this.options.runtimeDirectory) {
          const adapter = JSON.parse(await readFile(path.join(current, "node_modules", "@agentclientprotocol", "codex-acp", "package.json"), "utf8")).version;
          const codex = JSON.parse(await readFile(path.join(current, "node_modules", "@openai", "codex", "package.json"), "utf8")).version;
          const temporary = `${selection}.${crypto.randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify({ directory: current, adapter, codex })); await rename(temporary, selection);
        } else if (!current) await rm(selection, { force: true });
        // Obsolete rollback references must not point at deleted releases.
        for (const name of await names(this.options.home)) if (/^\.vibe-server-[\w-]+\.release(?:\.previous)?$/.test(name)) {
          const file = path.join(this.options.home, name); await safe(file);
          const release = (await readFile(file, "utf8")).trim();
          if (obsolete.some((entry) => entry.path === path.join(this.deployment, "releases", release))) await rm(file);
        }
      } finally { await rm(provisionLock, { recursive: true, force: true }); }
    }));
  }
}
