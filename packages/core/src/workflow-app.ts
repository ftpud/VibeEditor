import { managedProcesses } from "./managed-processes.js";
import { EventEmitter } from "node:events";
import { TerminalSessionHost, type TerminalSnapshot } from "./process-manager.js";
import crypto from "node:crypto";
import { stat } from "node:fs/promises";
import { workspaceShellCommand } from "./workspace-shell.js";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { AiSession, HarnessAppState, HarnessAppAction, HarnessBlock } from "@remote-ide/protocol";

type App = { events: EventEmitter; terminalIds: Map<string, string>; launchId: string; child: IPty; output: string; status: "starting" | "running" | "exited"; exitCode: number | null; signal: string | null; ready: Promise<void>; closed: Promise<void> };

/** Apps outlive individual workflow runs and are stopped when the Core server closes. */
export class WorkflowAppService {
  constructor(readonly terminals = new TerminalSessionHost(() => {})) {}

  private readonly apps = new Map<string, App>();
  private closing = false;
  private readonly operations = new Map<string, Promise<AiSession>>();

  async execute(block: HarnessBlock, input: string, workspace: string, assertActive: () => void, context: { rootWorkspace?: string; workflowRunId?: string; workflowBlockId?: string } = {}): Promise<AiSession> {
    const key = `${path.resolve(workspace)}\0${block.app?.name.trim() ?? ""}`;
    const operation = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.executeLocked(block, input, workspace, assertActive, context));
    this.operations.set(key, operation);
    try { return await operation; }
    finally { if (this.operations.get(key) === operation) this.operations.delete(key); }
  }

  private async executeLocked(block: HarnessBlock, input: string, workspace: string, assertActive: () => void, context: { rootWorkspace?: string; workflowRunId?: string; workflowBlockId?: string } = {}): Promise<AiSession> {
    assertActive();
    const options = block.app;
    if (!options || !options.name.trim() || options.name.length > 120 || options.name.includes("\0")) throw new Error("Run App needs an app name of 1 to 120 characters");
    const allowed = options.actions ?? (options.action ? [options.action] : []);
    let lines: unknown = options.lines ?? 100;
    let action: unknown = allowed.includes("start") ? "start" : allowed.length === 1 ? allowed[0] : undefined;
    // Tool calls can choose an allowed action while keeping the app's stdin separate.
    try {
      const request: unknown = JSON.parse(input);
      if (request && typeof request === "object" && "action" in request) {
        action = request.action;
        if ("lines" in request) lines = request.lines;
        input = "input" in request && typeof request.input === "string" ? request.input : "";
      }
    } catch { /* Plain text remains the start script's input. */ }
    if (!allowed.includes(action as HarnessAppAction)) throw new Error(`Choose an allowed Run App action${action !== undefined ? ` (received '${String(action)}')` : ""}. Allowed actions: ${allowed.join(", ") || "none"}`);
    const name = options.name.trim();
    const key = `${path.resolve(workspace)}\0${name}`;
    let app = this.apps.get(key);
    if (this.closing) throw new Error("Core is shutting down");
    if (action === "start" && app?.status === "exited") await managedProcesses.listApps();
    if (action === "start") {
      if (!block.command?.trim()) throw new Error("Run App start needs a shell script");
      if (!app || (app.status === "exited" && !managedProcesses.appSnapshot(app.launchId))) {
        if (!(await stat(workspace)).isDirectory()) throw new Error("App workspace is not a directory");
        assertActive();
        const { shell, args } = workspaceShellCommand(block.command);
        const processContext = { ...context, rootWorkspace: context.rootWorkspace ?? workspace, workspace, kind: "workflow-app" as const, appName: name, command: `${name}: ${block.command}` };
        const launch = managedProcesses.prepare(processContext);
        let child: IPty;
        try { child = spawn(shell, args, { cwd: workspace, env: { ...launch.env, TERM: "xterm-256color", COLORTERM: "truecolor", VIBE_WORKFLOW_INPUT: input }, name: "xterm-256color", cols: 100, rows: 30 }); }
        catch (error) { managedProcesses.abandon(launch.launchId); throw error; }
        const launchId = launch.launchId;
        const lifecycle = Object.assign(new EventEmitter(), { pid: child.pid });
        managedProcesses.track(lifecycle, processContext, launchId);
        app = { events: new EventEmitter(), terminalIds: new Map(), launchId, child, output: "", status: "running", exitCode: null, signal: null, ready: Promise.resolve(), closed: Promise.resolve() };
        const current = app;
        child.onData((data) => { current.output = (current.output + data).slice(-200_000); current.events.emit("output", data); });
        current.closed = new Promise<void>((resolve) => child.onExit(({ exitCode, signal }) => {
          current.status = "exited"; current.exitCode = exitCode; current.signal = signal === 9 ? "SIGKILL" : signal ? String(signal) : null;
          lifecycle.emit("exit"); current.events.emit("exit", exitCode); resolve();
        }));
        this.apps.set(key, current);

      }
      await app.ready;
      this.openTerminal(name, workspace, workspace, this.terminals);
    } else if (action === "kill") {
      if (app) {
        if (app.status !== "exited") await app.ready;
        const killed = await this.kill(app);
        if (killed) await app.closed;
      }
    } else if (action === "tail") {
      if (!Number.isInteger(lines) || typeof lines !== "number" || lines < 1 || lines > 10_000) throw new Error("Tail lines must be an integer from 1 to 10000");
      if (!app) throw new Error(`App '${name}' has not been started in this workspace`);
    } else if (action !== "status") throw new Error("Unknown Run App action");
    assertActive();
    const tail = action === "tail" ? tailLines(app!.output, lines as number) : undefined;
    // Keep even heavily escaped log text below the workflow's output limit as JSON.
    const result = { name, status: app ? managedProcesses.appSnapshot(app.launchId)?.status ?? app.status : "not_found", ...(app ? { pid: app.child.pid, exitCode: app.exitCode, signal: app.signal } : {}), ...(tail !== undefined ? { output: tail.slice(-30_000), truncated: tail.length > 30_000 } : {}) };
    return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] } as AiSession;
  }

  openTerminal(name: string, workspace: string, terminalWorkspace: string, host: TerminalSessionHost): TerminalSnapshot {
    const app = this.apps.get(`${path.resolve(workspace)}\0${name.trim()}`);
    if (!app) throw new Error(`App '${name}' has not been started in this workspace`);
    const existing = app.terminalIds.get(terminalWorkspace);
    const snapshot = existing && host.attach(terminalWorkspace, existing);
    if (snapshot) return snapshot;
    const terminal = host.createOutput(terminalWorkspace, app.output.replace(/(?<!\r)\n/g, "\r\n"), (data, exit) => {
      const output = (chunk: string) => data(chunk.replace(/(?<!\r)\n/g, "\r\n"));
      app.events.on("output", output); app.events.on("exit", exit);
      return () => { app.events.off("output", output); app.events.off("exit", exit); };
    }, app.status === "exited" ? app.exitCode ?? 1 : undefined, { displayName: name, write: (data) => app.child.write(data), resize: (cols, rows) => app.child.resize(cols, rows) });
    app.terminalIds.set(terminalWorkspace, terminal.terminalId);
    return terminal;
  }

  read(name: string, workspace: string): HarnessAppState {
    const app = this.apps.get(`${path.resolve(workspace)}\0${name.trim()}`);
    return { name: name.trim(), status: app ? managedProcesses.appSnapshot(app.launchId)?.status ?? app.status : "not_found", output: app?.output ?? "", ...(app ? { pid: app.child.pid, exitCode: app.exitCode, signal: app.signal } : {}) };
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    await Promise.all([...this.apps.values()].map((app) => this.kill(app)));
  }

  hasWorkspace(workspace: string): boolean {
    const prefix = `${path.resolve(workspace)}\0`;
    return [...this.apps].some(([key, app]) => key.startsWith(prefix) && (app.status !== "exited" || !!managedProcesses.appSnapshot(app.launchId)));
  }

  private async kill(app: App): Promise<boolean> {
    return managedProcesses.kill(`app:${app.launchId}`, async () => true);
  }
}

function tailLines(output: string, lines: number): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const entries = normalized.split("\n");
  if (entries.at(-1) === "") entries.pop();
  return entries.slice(-lines).join("\n");
}
