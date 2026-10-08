import crypto from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AiSession, HarnessAppState, HarnessAppAction, HarnessBlock } from "@remote-ide/protocol";

type App = { child: ChildProcessWithoutNullStreams; output: string; status: "starting" | "running" | "exited"; exitCode: number | null; signal: string | null; ready: Promise<void>; closed: Promise<void> };

/** Apps outlive individual workflow runs and are stopped when the Core server closes. */
export class WorkflowAppService {
  private readonly apps = new Map<string, App>();
  private closing = false;

  async execute(block: HarnessBlock, input: string, workspace: string, assertActive: () => void): Promise<AiSession> {
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
    if (action === "start") {
      if (!block.command?.trim()) throw new Error("Run App start needs a shell script");
      if (!app || app.status === "exited") {
        const child = spawn("/bin/sh", ["-c", block.command], { cwd: workspace, env: { ...process.env, VIBE_WORKFLOW_INPUT: input }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        app = { child, output: "", status: "starting", exitCode: null, signal: null, ready: Promise.resolve(), closed: Promise.resolve() };
        const current = app;
        const collect = (chunk: Buffer) => { current.output = (current.output + chunk.toString()).slice(-200_000); };
        child.stdout.on("data", collect); child.stderr.on("data", collect);
        child.stdin.on("error", () => {}); child.stdin.end(input);
        current.ready = new Promise<void>((resolve, reject) => {
          child.once("spawn", () => { current.status = "running"; resolve(); });
          child.once("error", (error) => { current.status = "exited"; reject(error); });
        });
        current.closed = new Promise<void>((resolve) => child.once("close", (code, signal) => { current.status = "exited"; current.exitCode = code; current.signal = signal; resolve(); }));
        this.apps.set(key, current);
      }
      await app.ready;
    } else if (action === "kill") {
      if (app && app.status !== "exited") {
        await app.ready;
        this.kill(app);
        await app.closed;
      }
    } else if (action === "tail") {
      if (!Number.isInteger(lines) || typeof lines !== "number" || lines < 1 || lines > 10_000) throw new Error("Tail lines must be an integer from 1 to 10000");
      if (!app) throw new Error(`App '${name}' has not been started in this workspace`);
    } else if (action !== "status") throw new Error("Unknown Run App action");
    assertActive();
    const tail = action === "tail" ? tailLines(app!.output, lines as number) : undefined;
    // Keep even heavily escaped log text below the workflow's output limit as JSON.
    const result = { name, status: app?.status ?? "not_found", ...(app ? { pid: app.child.pid, exitCode: app.exitCode, signal: app.signal } : {}), ...(tail !== undefined ? { output: tail.slice(-30_000), truncated: tail.length > 30_000 } : {}) };
    return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] } as AiSession;
  }

  read(name: string, workspace: string): HarnessAppState {
    const app = this.apps.get(`${path.resolve(workspace)}\0${name.trim()}`);
    return { name: name.trim(), status: app?.status ?? "not_found", output: app?.output ?? "", ...(app ? { pid: app.child.pid, exitCode: app.exitCode, signal: app.signal } : {}) };
  }

  closeAll(): void {
    this.closing = true;
    for (const app of this.apps.values()) if (app.status !== "exited") this.kill(app);
  }

  hasWorkspace(workspace: string): boolean {
    const prefix = `${path.resolve(workspace)}\0`;
    return [...this.apps].some(([key, app]) => key.startsWith(prefix) && app.status !== "exited");
  }

  private kill(app: App): void {
    if (!app.child.pid) return;
    try { process.kill(-app.child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

function tailLines(output: string, lines: number): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const entries = normalized.split("\n");
  if (entries.at(-1) === "") entries.pop();
  return entries.slice(-lines).join("\n");
}
