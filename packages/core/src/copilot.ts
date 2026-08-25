import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AiMessage, AiModel, AiSession } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const EMPTY: AiSession = { model: "default", reasoning: "medium", status: "idle", messages: [] };

export class CopilotSessionManager {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {}

  async get(workspace: string): Promise<AiSession> {
    try {
      const saved = JSON.parse(await readFile(this.file(workspace), "utf8")) as AiSession;
      return { ...EMPTY, ...saved, status: this.processes.has(workspace) ? "in_progress" : saved.status === "in_progress" ? "error" : saved.status, messages: Array.isArray(saved.messages) ? saved.messages.slice(-1000) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, messages: [] };
      throw new CoreError("READ_FAILED", `Could not load Copilot session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async models(): Promise<AiModel[]> {
    return ["default", "gpt-5.3-codex", "claude-sonnet-4.6", "claude-opus-4.6", "claude-haiku-4.5"].map((id) => ({ id, name: id === "default" ? "Copilot default" : id, defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh"] }));
  }

  async send(workspace: string, prompt: string, model: string, reasoning: string): Promise<AiSession> {
    if (!prompt.trim() || prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Copilot is already working on this task");
    const session = await this.get(workspace);
    session.threadId ??= crypto.randomUUID();
    session.model = model; session.reasoning = reasoning; session.status = "in_progress"; session.messages.push(toMessage("user", prompt.trim()));
    await this.save(workspace, session); this.onChanged(workspace);
    const args = ["-p", prompt.trim(), "--output-format=json", "--stream=on", `--session-id=${session.threadId}`, `--reasoning-effort=${reasoning}`, "--allow-tool=read", "--allow-tool=write", "--allow-tool=shell", "--no-ask-user", "--no-color"];
    if (model && model !== "default") args.push(`--model=${model}`);
    const child = spawn("copilot", args, { cwd: workspace, env: process.env });
    this.processes.set(workspace, child);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.on("error", (error) => { void this.finish(workspace, 1, stdout, (error as NodeJS.ErrnoException).code === "ENOENT" ? "Copilot CLI is not installed. Install and authenticate the `copilot` command first." : error.message); });
    child.on("close", (code) => { void this.finish(workspace, code ?? 1, stdout, stderr); });
    return session;
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Copilot is still working on this task");
    const current = await this.get(workspace);
    const session: AiSession = { model: current.model, reasoning: current.reasoning, status: "idle", messages: [] };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  private async finish(workspace: string, code: number, stdout: string, stderr: string): Promise<void> {
    if (!this.processes.has(workspace)) return;
    this.processes.delete(workspace);
    const session = await this.get(workspace);
    const response = copilotResponse(stdout);
    if (response) session.messages.push(toMessage("assistant", response));
    if (code === 0) session.status = "done";
    else { session.status = "error"; session.messages.push(toMessage("error", (stderr.trim() || "Copilot CLI failed").slice(-8000))); }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  private file(workspace: string): string { return path.join(this.stateDirectory, `${crypto.createHash("sha256").update(workspace).digest("hex")}-copilot.json`); }
  private async save(workspace: string, session: AiSession): Promise<void> { await mkdir(this.stateDirectory, { recursive: true }); const file = this.file(workspace); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify({ ...session, messages: session.messages.slice(-1000) }, null, 2)}\n`); await rename(temp, file); }
}

function copilotResponse(output: string): string {
  const parts: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const value = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : event;
      const text = [value.content, value.text, value.message].find((item): item is string => typeof item === "string");
      if (text && !parts.includes(text)) parts.push(text);
    } catch { if (line.trim() && !line.trimStart().startsWith("{")) parts.push(line); }
  }
  return parts.join("\n").trim();
}

function toMessage(role: AiMessage["role"], text: string): AiMessage { return { id: crypto.randomUUID(), role, text, timestamp: new Date().toISOString() }; }
