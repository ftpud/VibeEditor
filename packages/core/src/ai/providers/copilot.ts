import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AiConfiguration, AiMessage, AiModel, AiProviderDescriptor, AiSession, AiUsage } from "@remote-ide/protocol";
import { CoreError } from "../../errors.js";
import { AcpProvider, applyConfiguration, mergeConfiguration, type AcpSendRequest } from "../acp.js";
import { execInShell, spawnInShell } from "../../shell-process.js";

const EMPTY: AiSession = { model: "auto", reasoning: "medium", status: "idle", messages: [] };
const FALLBACK_MODELS = ["claude-sonnet-4.6", "gpt-5.4", "claude-haiku-4.5", "gpt-5.3-codex", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "mai-code-1-flash"];

export class CopilotSessionManager extends AcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "copilot", name: "Copilot CLI", description: "GitHub Copilot's coding agent running through the local CLI.",
    settings: { title: "Copilot settings", description: "Tune how Copilot plans, reasons, and consumes context for this workspace.", sections: [{ id: "behavior", name: "Behavior", description: "How the agent approaches a task." }, { id: "limits", name: "Context & limits", description: "Resource and context safeguards." }, { id: "output", name: "Output", description: "Optional details shown in responses." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true },
    options: [
      { id: "context", name: "Context window", description: "Use more project context for large tasks. Long context can consume more quota.", section: "limits", type: "select", defaultValue: "default", choices: [{ value: "default", name: "Default" }, { value: "long_context", name: "Long context" }] },
      { id: "mode", name: "Agent mode", description: "Interactive works normally, Plan focuses on analysis, and Autopilot minimizes interruptions.", section: "behavior", type: "select", defaultValue: "interactive", choices: [{ value: "interactive", name: "Interactive" }, { value: "plan", name: "Plan" }, { value: "autopilot", name: "Autopilot" }] },
      { id: "maxAiCredits", name: "Maximum AI credits", description: "Optional per-session spending guard. Set to 0 to use the provider default.", section: "limits", type: "number", defaultValue: 0, min: 0 },
      { id: "reasoningSummaries", name: "Reasoning summaries", description: "Include concise reasoning summaries when the provider supports them.", section: "output", type: "boolean", defaultValue: false },
    ]
  };
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly toolNames = new Map<string, Map<string, string>>();
  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) { super(); }

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
    try {
      const { stdout, stderr } = await execInShell("copilot", ["completion", "bash"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10_000 });
      const provided = parseCopilotModels(`${stdout}\n${stderr}`);
      return provided.length > 1 ? provided : copilotModels(["auto", ...FALLBACK_MODELS]);
    } catch {
      return [{ id: "auto", name: "Auto (Copilot CLI unavailable)", defaultReasoning: "medium", reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }];
    }
  }

  async send(workspace: string, request: AcpSendRequest | string, legacyModel?: string, legacyReasoning?: string): Promise<AiSession> {
    const normalized: AcpSendRequest = typeof request === "string" ? { prompt: request, configuration: { model: legacyModel ?? EMPTY.model, reasoning: legacyReasoning ?? EMPTY.reasoning } } : request;
    const prompt = normalized.prompt;
    if (!prompt.trim() || prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Copilot is already working on this task");
    const session = await this.get(workspace);
    session.threadId ??= crypto.randomUUID();
    applyConfiguration(session, normalized.configuration);
    session.status = "in_progress"; session.messages.push(toMessage("user", prompt.trim()));
    await this.save(workspace, session);
    const configuration = mergeConfiguration(session, normalized.configuration);
    const effectivePrompt = normalized.agent ? `${normalized.agent.instructions.trim()}\n\n${prompt.trim()}` : prompt.trim();
    const args = ["-p", effectivePrompt, "--output-format=json", "--stream=on", `--session-id=${session.threadId}`, `--reasoning-effort=${session.reasoning}`, "--allow-all-tools", "--no-ask-user", "--no-color"];
    if (session.model) args.push(`--model=${session.model}`);
    if (configuration.context) args.push(`--context=${String(configuration.context)}`);
    if (configuration.mode && configuration.mode !== "interactive") args.push(`--mode=${String(configuration.mode)}`);
    if (typeof configuration.maxAiCredits === "number" && configuration.maxAiCredits > 0) args.push(`--max-ai-credits=${configuration.maxAiCredits}`);
    if (configuration.reasoningSummaries === true) args.push("--enable-reasoning-summaries");
    if (normalized.mcpServers?.length) args.push("--additional-mcp-config", JSON.stringify({ mcpServers: Object.fromEntries(normalized.mcpServers.filter((item) => item.enabled !== false && (!normalized.agent?.mcpServers || normalized.agent.mcpServers.includes(item.name))).map((item) => [item.name, { command: item.command, args: item.args, env: item.env }])) }));
    const child = spawnInShell("copilot", args, workspace);
    this.processes.set(workspace, child);
    this.onChanged(workspace);
    this.toolNames.set(workspace, new Map());
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); const lines = stdout.split("\n"); stdout = lines.pop() ?? ""; for (const line of lines) this.queue(workspace, () => this.consume(workspace, line)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.on("error", (error) => { void this.finish(workspace, 1, (error as NodeJS.ErrnoException).code === "ENOENT" ? "Copilot CLI is not installed. Install and authenticate the `copilot` command first." : error.message); });
    child.on("close", (code) => { if (stdout.trim()) this.queue(workspace, () => this.consume(workspace, stdout)); this.queue(workspace, () => this.finish(workspace, code ?? 1, stderr)); });
    return session;
  }

  async configure(workspace: string, configuration: AiConfiguration | string, legacyReasoning?: string): Promise<AiSession> {
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Copilot is already working on this task");
    const session = await this.get(workspace);
    applyConfiguration(session, typeof configuration === "string" ? { model: configuration, reasoning: legacyReasoning ?? session.reasoning } : configuration);
    await this.save(workspace, session); this.onChanged(workspace);
    return session;
  }

  async interrupt(workspace: string): Promise<AiSession> {
    const child = this.processes.get(workspace);
    if (!child) throw new CoreError("INVALID_REQUEST", "Copilot is not currently working");
    this.processes.delete(workspace); this.toolNames.delete(workspace);
    child.kill("SIGTERM");
    const session = await this.get(workspace);
    session.status = "idle";
    session.messages.push(toMessage("activity", "Interrupted by user"));
    await this.save(workspace, session); this.onChanged(workspace);
    return session;
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Copilot is still working on this task");
    const current = await this.get(workspace);
    const session: AiSession = { model: current.model, reasoning: current.reasoning, configuration: current.configuration, status: "idle", messages: [] };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  private async consume(workspace: string, line: string): Promise<void> {
    let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const session = await this.get(workspace);
    const data = event.data as Record<string, unknown> | undefined;
    const names = this.toolNames.get(workspace) ?? new Map<string, string>();
    if (event.type === "result" && typeof event.sessionId === "string") session.threadId = event.sessionId;
    else if (event.type === "assistant.message" && data && typeof data.content === "string" && data.content.trim()) session.messages.push(toMessage("assistant", data.content.trim()));
    else if (event.type === "tool.execution_start" && data && typeof data.toolCallId === "string" && typeof data.toolName === "string") names.set(data.toolCallId, data.toolName);
    else if (event.type === "tool.execution_complete" && data && typeof data.toolCallId === "string") {
      const toolName = names.get(data.toolCallId) ?? "tool"; names.delete(data.toolCallId);
      const result = data.result as Record<string, unknown> | undefined;
      const content = typeof result?.content === "string" ? result.content : "";
      if (data.success === false) session.messages.push(toMessage("error", `${toolName}\n${content}`.trim()));
      else session.messages.push(toMessage("activity", `${toolName}\n${content}`.trim()));
    } else if ((event.type === "request_user_input" || event.type === "user_input_request") && data) { session.status = "user_prompt"; session.messages.push(toMessage("activity", String(data.question ?? data.text ?? "Copilot is waiting for user input"))); }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  async usage(): Promise<AiUsage> {
    return { supported: true, label: "Copilot exposes quota and token details through its interactive /usage command. Per-session limits can be set here with Maximum AI credits." };
  }

  private async finish(workspace: string, code: number, stderr: string): Promise<void> {
    if (!this.processes.has(workspace)) return;
    this.processes.delete(workspace); this.toolNames.delete(workspace);
    const session = await this.get(workspace);
    if (code === 0 && session.status !== "user_prompt") session.status = "done";
    else { const prompt = /approval|permission|user input|prompt/i.test(stderr); session.status = prompt ? "user_prompt" : "error"; if (stderr.trim()) session.messages.push(toMessage(prompt ? "activity" : "error", stderr.trim().slice(-8000))); }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  private file(workspace: string): string { return path.join(this.stateDirectory, `${crypto.createHash("sha256").update(workspace).digest("hex")}-copilot.json`); }
  private queue(workspace: string, operation: () => Promise<void>): void { const next = (this.queues.get(workspace) ?? Promise.resolve()).then(operation).catch(() => undefined); this.queues.set(workspace, next); void next.finally(() => { if (this.queues.get(workspace) === next) this.queues.delete(workspace); }); }
  private async save(workspace: string, session: AiSession): Promise<void> { await mkdir(this.stateDirectory, { recursive: true }); const file = this.file(workspace); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify({ ...session, messages: session.messages.slice(-1000) }, null, 2)}\n`); await rename(temp, file); }
}

function toMessage(role: AiMessage["role"], text: string): AiMessage { return { id: crypto.randomUUID(), role, text, timestamp: new Date().toISOString() }; }

export function parseCopilotModels(helpOutput: string): AiModel[] {
  const output = helpOutput.replace(/\x1b\[[0-9;]*m/g, "");
  const choices = output.match(/--model\)\s*[\s\S]*?compgen\s+-W\s+(['"])(.*?)\1/)?.[2] ?? "";
  const discovered = choices.split(/\s+/).filter(Boolean).map((model) => model.toLowerCase());
  return copilotModels(["auto", ...discovered]);
}

function copilotModels(values: string[]): AiModel[] {
  const ids = values.filter((id, index, all) => all.indexOf(id) === index);
  return ids.map((id) => ({ id, name: id === "auto" ? "Auto (Copilot)" : id, defaultReasoning: "medium", reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }));
}
