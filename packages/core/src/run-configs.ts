import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { RunConfig, RunConfigScope } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { TerminalSessionHost, type TerminalEvent } from "./process-manager.js";

type Runtime = { status: RunConfig["status"]; terminalId?: string; exitCode?: number; restart?: boolean };
const key = (workspace: string, scope: RunConfigScope, name: string) => `${path.resolve(workspace)}\0${scope}\0${name}`;

/** File-backed shell run configurations. Discovery only reads text; execution is always explicit. */
export class RunConfigService {
  private readonly runtime = new Map<string, Runtime>();
  private readonly storageRoot: string;
  private readonly localDirectory: string;
  constructor(private readonly terminals: TerminalSessionHost, private readonly changed: (workspace: string) => void, rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    this.storageRoot = path.join(stateDirectory, "run-configs");
    const workspaceKey = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.localDirectory = path.join(this.storageRoot, "local", workspaceKey);
  }

  directory(workspace: string, scope: RunConfigScope): string {
    if (scope !== "local" && scope !== "global") throw new CoreError("INVALID_REQUEST", "Invalid run configuration scope");
    return scope === "local" ? this.localDirectory : path.join(this.storageRoot, "global");
  }
  private target(workspace: string, scope: RunConfigScope, name: string): string {
    if (!name || name.length > 120 || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0") || /[\\/]/.test(name)) throw new CoreError("INVALID_REQUEST", "Run configuration name must be a plain file name");
    return path.join(this.directory(workspace, scope), name.endsWith(".sh") ? name : `${name}.sh`);
  }
  private displayName(file: string): string { return file.endsWith(".sh") ? file.slice(0, -3) : file; }
  async list(workspace: string): Promise<RunConfig[]> {
    const collect = async (scope: RunConfigScope): Promise<RunConfig[]> => { try { return await Promise.all((await readdir(this.directory(workspace, scope), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".sh")).map((entry) => this.read(workspace, scope, this.displayName(entry.name)))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } };
    return [...await collect("global"), ...await collect("local")].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  }
  async read(workspace: string, scope: RunConfigScope, name: string): Promise<RunConfig> {
    const normalized = this.displayName(name); let commands: string;
    try { commands = await readFile(this.target(workspace, scope, normalized), "utf8"); } catch (error) { throw new CoreError("RUN_CONFIG_NOT_FOUND", `Run configuration not found: ${normalized}`); }
    return { scope, name: normalized, commands, ...(this.runtime.get(key(workspace, scope, normalized)) ?? { status: "idle" }) };
  }
  async create(workspace: string, scope: RunConfigScope, name: string, commands: string): Promise<RunConfig> {
    this.validateCommands(commands); const normalized = this.displayName(name); const target = this.target(workspace, scope, normalized); await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, commands, { encoding: "utf8", flag: "wx" }); } catch (error) { throw new CoreError("RUN_CONFIG_FAILED", `Could not create run configuration: ${error instanceof Error ? error.message : String(error)}`); }
    this.changed(workspace); return this.read(workspace, scope, normalized);
  }
  async write(workspace: string, scope: RunConfigScope, name: string, commands: string): Promise<RunConfig> { this.validateCommands(commands); const current = await this.read(workspace, scope, name); if (["starting", "running", "stopping"].includes(current.status)) throw new CoreError("RUN_CONFIG_RUNNING", "Stop the run configuration before editing it"); await writeFile(this.target(workspace, scope, name), commands, "utf8"); this.changed(workspace); return this.read(workspace, scope, name); }
  async run(workspace: string, scope: RunConfigScope, name: string): Promise<RunConfig> {
    const config = await this.read(workspace, scope, name); if (["starting", "running", "stopping"].includes(config.status)) throw new CoreError("RUN_CONFIG_RUNNING", `${config.name} is already active`);
    const state: Runtime = { status: "starting" }; this.runtime.set(key(workspace, scope, config.name), state); this.changed(workspace);
    const cwd = scope === "local" ? path.resolve(workspace) : os.homedir(); const terminal = this.terminals.create(workspace, 80, 24, cwd); state.terminalId = terminal.terminalId; state.status = "running";
    this.terminals.input(workspace, terminal.terminalId, `${config.commands}${config.commands.endsWith("\n") ? "" : "\n"}exit $?\n`); this.changed(workspace); return this.read(workspace, scope, config.name);
  }
  async stop(workspace: string, scope: RunConfigScope, name: string): Promise<RunConfig> { const config = await this.read(workspace, scope, name); if (!config.terminalId || !["starting", "running"].includes(config.status)) return config; const state = this.runtime.get(key(workspace, scope, config.name))!; state.status = "stopping"; this.changed(workspace); this.terminals.terminate(workspace, config.terminalId); return this.read(workspace, scope, name); }
  async restart(workspace: string, scope: RunConfigScope, name: string): Promise<RunConfig> { const config = await this.read(workspace, scope, name); if (["starting", "running", "stopping"].includes(config.status)) { const state = this.runtime.get(key(workspace, scope, config.name))!; state.restart = true; await this.stop(workspace, scope, name); return this.read(workspace, scope, name); } return this.run(workspace, scope, name); }
  onTerminalEvent(event: TerminalEvent): void { if (event.type !== "exit") return; for (const [id, state] of this.runtime) { if (state.terminalId !== event.terminalId) continue; const [workspace, scope, name] = id.split("\0") as [string, RunConfigScope, string]; state.exitCode = event.exitCode; state.status = event.exitCode === 0 ? "succeeded" : "failed"; this.changed(workspace); if (state.restart) { state.restart = false; void this.run(workspace, scope, name).catch(() => undefined); } } }
  /** Keeps lifecycle state accurate when a client explicitly disposes an associated terminal. */
  onTerminalClosed(workspace: string, terminalId: string): void { for (const [id, state] of this.runtime) { if (state.terminalId !== terminalId || !["starting", "running", "stopping"].includes(state.status)) continue; const [owner] = id.split("\0"); if (path.resolve(owner!) !== path.resolve(workspace)) continue; state.status = "failed"; state.exitCode = 130; state.restart = false; this.changed(owner!); } }
  private validateCommands(commands: string): void { if (typeof commands !== "string" || Buffer.byteLength(commands) > 1024 * 1024) throw new CoreError("INVALID_REQUEST", "Run configuration commands must be text smaller than 1 MB"); }
}
