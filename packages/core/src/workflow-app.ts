import crypto from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";

type App = { child: ChildProcessWithoutNullStreams; output: string; status: "starting" | "running" | "exited"; exitCode: number | null; signal: string | null; ready: Promise<void>; closed: Promise<void> };

/** Apps outlive individual workflow runs and are stopped when the Core server closes. */
export class WorkflowAppService {
  private readonly apps = new Map<string, App>();
  private closing = false;

  async execute(block: HarnessBlock, input: string, workspace: string, assertActive: () => void): Promise<AiSession> {
    assertActive();
    const options = block.app;
    if (!options || !options.name.trim() || options.name.length > 120 || options.name.includes("\0")) throw new Error("Run App needs an app name of 1 to 120 characters");
    const name = options.name.trim();
    const key = `${path.resolve(workspace)}\0${name}`;
    let app = this.apps.get(key);
    if (this.closing) throw new Error("Core is shutting down");
    if (options.action === "start") {
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
    } else if (options.action === "kill") {
      if (app && app.status !== "exited") {
        await app.ready;
        this.kill(app);
        await app.closed;
      }
    } else if (options.action === "tail") {
      if (!Number.isInteger(options.lines ?? 100) || (options.lines ?? 100) < 1 || (options.lines ?? 100) > 10_000) throw new Error("Tail lines must be an integer from 1 to 10000");
      if (!app) throw new Error(`App '${name}' has not been started in this workspace`);
    } else if (options.action !== "status") throw new Error("Unknown Run App action");
    assertActive();
    const tail = options.action === "tail" ? tailLines(app!.output, options.lines ?? 100) : undefined;
    // Keep even heavily escaped log text below the workflow's output limit as JSON.
    const result = { name, status: app?.status ?? "not_found", ...(app ? { pid: app.child.pid, exitCode: app.exitCode, signal: app.signal } : {}), ...(tail !== undefined ? { output: tail.slice(-30_000), truncated: tail.length > 30_000 } : {}) };
    return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] } as AiSession;
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
