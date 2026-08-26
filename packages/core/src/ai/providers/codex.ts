import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AiConfiguration, AiMessage, AiModel, AiProviderDescriptor, AiSession } from "@remote-ide/protocol";
import { CoreError } from "../../errors.js";
import { AcpProvider, applyConfiguration, mergeConfiguration, type AcpSendRequest } from "../acp.js";
import { spawnInShell } from "../../shell-process.js";

const EMPTY: AiSession = { model: "gpt-5.6-sol", reasoning: "low", status: "idle", messages: [] };

export class CodexSessionManager extends AcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "codex", name: "Codex CLI",
    capabilities: { models: true, usage: false, mcp: true, agents: true, contextWindow: false },
    options: [
      { id: "sandbox", name: "Sandbox", type: "select", defaultValue: "workspace-write", choices: [{ value: "read-only", name: "Read only" }, { value: "workspace-write", name: "Workspace write" }] },
      { id: "webSearch", name: "Web search", type: "boolean", defaultValue: false },
    ]
  };
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) { super(); }

  async get(workspace: string): Promise<AiSession> {
    try {
      const saved = JSON.parse(await readFile(this.file(workspace), "utf8")) as AiSession;
      return { ...EMPTY, ...saved, status: this.processes.has(workspace) ? "in_progress" : saved.status === "in_progress" ? "error" : saved.status, messages: Array.isArray(saved.messages) ? saved.messages.slice(-1000) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, messages: [] };
      throw new CoreError("READ_FAILED", `Could not load Codex session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async models(): Promise<AiModel[]> {
    try {
      const cache = JSON.parse(await readFile(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8")) as { models?: Record<string, unknown>[] };
      return (cache.models ?? []).filter((item) => item.visibility !== "hidden" && typeof item.slug === "string").map((item) => ({
        id: item.slug as string, name: typeof item.display_name === "string" ? item.display_name : item.slug as string,
        defaultReasoning: typeof item.default_reasoning_level === "string" ? item.default_reasoning_level : "medium",
        reasoningLevels: Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.map((level) => (level as { effort?: unknown }).effort).filter((effort): effort is string => typeof effort === "string") : ["medium"]
      }));
    } catch { return [{ id: EMPTY.model, name: EMPTY.model, defaultReasoning: EMPTY.reasoning, reasoningLevels: ["low", "medium", "high", "xhigh"] }]; }
  }

  async send(workspace: string, request: AcpSendRequest | string, legacyModel?: string, legacyReasoning?: string): Promise<AiSession> {
    const normalized: AcpSendRequest = typeof request === "string" ? { prompt: request, configuration: { model: legacyModel ?? EMPTY.model, reasoning: legacyReasoning ?? EMPTY.reasoning } } : request;
    let prompt = normalized.prompt;
    if (!prompt.trim() || prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Codex is already working on this task");
    const session = await this.get(workspace);
    applyConfiguration(session, normalized.configuration);
    if (normalized.agent) prompt = `${normalized.agent.instructions.trim()}\n\n${prompt}`;
    session.status = "in_progress"; session.messages.push(toMessage("user", normalized.prompt.trim()));
    await this.save(workspace, session);
    const configuration = mergeConfiguration(session, normalized.configuration);
    const config = `model_reasoning_effort=${JSON.stringify(session.reasoning)}`;
    const args = session.threadId ? ["exec", "resume", session.threadId, "-", "--json", "-m", session.model, "-c", config] : ["exec", "-", "--json", "-C", workspace, "-s", String(configuration.sandbox ?? "workspace-write"), "-m", session.model, "-c", config];
    if (configuration.webSearch === true) args.push("-c", "features.web_search=true");
    for (const server of normalized.mcpServers?.filter((item) => item.enabled !== false && (!normalized.agent?.mcpServers || normalized.agent.mcpServers.includes(item.name))) ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new CoreError("INVALID_REQUEST", `Invalid MCP server name '${server.name}'`);
      const prefix = `mcp_servers.${server.name}`;
      args.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`);
      if (server.args?.length) args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
      for (const [name, value] of Object.entries(server.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CoreError("INVALID_REQUEST", `Invalid MCP environment variable '${name}'`);
        args.push("-c", `${prefix}.env.${name}=${JSON.stringify(value)}`);
      }
    }
    const child = spawnInShell("codex", args, workspace);
    this.processes.set(workspace, child);
    this.onChanged(workspace);
    let stdout = ""; let stderr = "";
    child.stdin.end(prompt.trim());
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); const lines = stdout.split("\n"); stdout = lines.pop() ?? ""; for (const line of lines) this.queue(workspace, () => this.consume(workspace, line)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.on("error", (error) => { void this.finish(workspace, 1, error.message); });
    child.on("close", (code) => { if (stdout.trim()) this.queue(workspace, () => this.consume(workspace, stdout)); this.queue(workspace, () => this.finish(workspace, code ?? 1, stderr)); });
    return session;
  }

  async configure(workspace: string, configuration: AiConfiguration | string, legacyReasoning?: string): Promise<AiSession> {
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Codex is already working on this task");
    const session = await this.get(workspace);
    applyConfiguration(session, typeof configuration === "string" ? { model: configuration, reasoning: legacyReasoning ?? session.reasoning } : configuration);
    await this.save(workspace, session); this.onChanged(workspace);
    return session;
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.processes.has(workspace)) throw new CoreError("INVALID_REQUEST", "Codex is still working on this task");
    const current = await this.get(workspace);
    const session: AiSession = { model: current.model, reasoning: current.reasoning, configuration: current.configuration, status: "idle", messages: [] };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  private async consume(workspace: string, line: string): Promise<void> {
    let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const session = await this.get(workspace);
    if (event.type === "thread.started" && typeof event.thread_id === "string") session.threadId = event.thread_id;
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === "item.completed" && item) {
      if (item.type === "agent_message" && typeof item.text === "string") session.messages.push(toMessage("assistant", item.text));
      else if (item.type === "command_execution") session.messages.push(toMessage("activity", `${String(item.command ?? "Command")}\n${String(item.aggregated_output ?? "").trim()}`.trim()));
      else if (item.type === "file_change") session.messages.push(toMessage("activity", "Files changed"));
      else if (item.type === "request_user_input" || item.type === "user_input_request") { session.status = "user_prompt"; session.messages.push(toMessage("activity", String(item.question ?? item.text ?? "Codex is waiting for user input"))); }
    }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  private async finish(workspace: string, code: number, stderr: string): Promise<void> {
    if (!this.processes.has(workspace)) return;
    this.processes.delete(workspace);
    const session = await this.get(workspace);
    if (code === 0 && session.status !== "user_prompt") session.status = "done";
    else { const prompt = /approval|permission|user input|prompt/i.test(stderr); session.status = prompt ? "user_prompt" : "error"; if (stderr.trim()) session.messages.push(toMessage(prompt ? "activity" : "error", stderr.trim().slice(-8000))); }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  private file(workspace: string): string { return path.join(this.stateDirectory, `${crypto.createHash("sha256").update(workspace).digest("hex")}-codex.json`); }
  private queue(workspace: string, operation: () => Promise<void>): void { const next = (this.queues.get(workspace) ?? Promise.resolve()).then(operation).catch(() => undefined); this.queues.set(workspace, next); void next.finally(() => { if (this.queues.get(workspace) === next) this.queues.delete(workspace); }); }
  private async save(workspace: string, session: AiSession): Promise<void> { await mkdir(this.stateDirectory, { recursive: true }); const file = this.file(workspace); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify({ ...session, messages: session.messages.slice(-1000) }, null, 2)}\n`); await rename(temp, file); }
}

function toMessage(role: AiMessage["role"], text: string): AiMessage { return { id: crypto.randomUUID(), role, text, timestamp: new Date().toISOString() }; }
