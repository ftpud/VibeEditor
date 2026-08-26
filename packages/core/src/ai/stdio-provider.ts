import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client, type McpServer, type SessionConfigOption, type SessionNotification } from "@agentclientprotocol/sdk";
import { AcpProvider, applyConfiguration, type AcpSendRequest, type AiConfiguration, type AiMessage, type AiModel, type AiProviderDescriptor, type AiSession, type AiUsage } from "@remote-ide/acp";
import { CoreError } from "../errors.js";

type Runtime = { child: ChildProcessWithoutNullStreams; connection: ClientSideConnection; sessionId: string; running: boolean; stderr: string };

/** Genuine ACP v1 client transport over NDJSON/stdio. */
export abstract class StdioAcpProvider extends AcpProvider {
  abstract readonly descriptor: AiProviderDescriptor;
  protected abstract command(configuration: AiConfiguration): { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  protected abstract fallbackModels(): Promise<AiModel[]>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) { super(); }

  async get(workspace: string): Promise<AiSession> {
    try {
      const saved = JSON.parse(await readFile(this.file(workspace), "utf8")) as AiSession;
      return { ...saved, model: saved.model ?? "auto", reasoning: saved.reasoning ?? "medium", status: this.runtimes.get(workspace)?.running ? "in_progress" : saved.status === "in_progress" ? "error" : saved.status, messages: Array.isArray(saved.messages) ? saved.messages.slice(-1000) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: "auto", reasoning: "medium", status: "idle", messages: [] };
      throw new CoreError("READ_FAILED", `Could not load ${this.descriptor.name} session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  models(): Promise<AiModel[]> { return this.fallbackModels(); }

  async configure(workspace: string, configuration: AiConfiguration | string, legacyReasoning?: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is currently working`);
    await this.closeRuntime(workspace);
    const session = await this.get(workspace); applyConfiguration(session, typeof configuration === "string" ? { model: configuration, reasoning: legacyReasoning ?? session.reasoning } : configuration);
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async send(workspace: string, request: AcpSendRequest): Promise<AiSession> {
    if (!request.prompt.trim() || request.prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    const session = await this.get(workspace);
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is already working`);
    applyConfiguration(session, request.configuration);
    const runtime = await this.ensureRuntime(workspace, session, request.mcpServers);
    runtime.running = true;
    session.status = "in_progress";
    session.messages.push(this.message("user", request.prompt.trim()));
    await this.save(workspace, session); this.onChanged(workspace);
    const prompt = request.agent ? `${request.agent.instructions.trim()}\n\n${request.prompt.trim()}` : request.prompt.trim();
    void runtime.connection.prompt({ sessionId: runtime.sessionId, prompt: [{ type: "text", text: prompt }] }).then(async (result) => {
      runtime.running = false;
      const current = await this.get(workspace); current.status = result.stopReason === "cancelled" ? "idle" : result.stopReason === "end_turn" ? "done" : "user_prompt";
      await this.save(workspace, current); this.onChanged(workspace);
    }).catch(async (error: unknown) => {
      runtime.running = false;
      const current = await this.get(workspace); current.status = "error"; current.messages.push(this.message("error", error instanceof Error ? error.message : String(error)));
      await this.save(workspace, current); this.onChanged(workspace);
    });
    return session;
  }

  async interrupt(workspace: string): Promise<AiSession> {
    const runtime = this.runtimes.get(workspace);
    if (!runtime?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is not currently working`);
    await runtime.connection.cancel({ sessionId: runtime.sessionId });
    runtime.running = false;
    const session = await this.get(workspace); session.status = "idle"; session.messages.push(this.message("activity", "Interrupted by user"));
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is still working`);
    await this.closeRuntime(workspace);
    const current = await this.get(workspace);
    const session: AiSession = { model: current.model, reasoning: current.reasoning, configuration: current.configuration, availableOptions: current.availableOptions, status: "idle", messages: [] };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async usage(): Promise<AiUsage> { return { supported: true, label: "Usage is reported by the ACP agent when supported." }; }

  private async ensureRuntime(workspace: string, session: AiSession, servers?: AcpSendRequest["mcpServers"]): Promise<Runtime> {
    const existing = this.runtimes.get(workspace); if (existing) return existing;
    const launch = this.command(session.configuration ?? {});
    const child = spawn(launch.command, launch.args, { cwd: workspace, env: { ...process.env, ...launch.env }, stdio: "pipe" });
    const runtime = { child, connection: undefined as unknown as ClientSideConnection, sessionId: "", running: false, stderr: "" };
    child.stderr.on("data", (chunk: Buffer) => { runtime.stderr = (runtime.stderr + chunk.toString()).slice(-20_000); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const client: Client = {
      requestPermission: (params) => { const allowed = params.options.find((option) => option.kind === "allow_once") ?? params.options.find((option) => option.kind === "allow_always"); return allowed ? { outcome: { outcome: "selected", optionId: allowed.optionId } } : { outcome: { outcome: "cancelled" } }; },
      sessionUpdate: (params) => this.queue(workspace, () => this.consumeUpdate(workspace, params))
    };
    runtime.connection = new ClientSideConnection(() => client, stream);
    child.on("error", (error) => { void this.runtimeFailed(workspace, error.message); });
    child.on("close", (code) => { if (this.runtimes.get(workspace) === runtime) { this.runtimes.delete(workspace); void this.runtimeFailed(workspace, runtime.stderr || `${this.descriptor.name} ACP server exited with code ${code ?? 1}`); } });
    let authHint = "";
    try {
      const initialized = await runtime.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "Vibe Editor", version: "0.1.0" } });
      authHint = initialized.authMethods?.map((method) => method.description ?? method.name).join("; ") ?? "";
      const created = await runtime.connection.newSession({ cwd: workspace, mcpServers: this.mcpServers(servers) });
      runtime.sessionId = created.sessionId; session.threadId = created.sessionId;
      session.availableOptions = this.toUiOptions(created.configOptions ?? [], created.modes);
      await this.applyAcpConfiguration(runtime.connection, created.sessionId, created.configOptions ?? [], created.modes, session);
      this.runtimes.set(workspace, runtime); await this.save(workspace, session); return runtime;
    } catch (error) { child.kill("SIGTERM"); const message = error instanceof Error ? error.message : String(error); throw new CoreError("TERMINAL_FAILED", `Could not start ${this.descriptor.name} ACP server: ${message}${/auth/i.test(message) && authHint ? `. ${authHint}` : ""}${runtime.stderr ? ` (${runtime.stderr.trim()})` : ""}`); }
  }

  private async applyAcpConfiguration(connection: ClientSideConnection, sessionId: string, options: SessionConfigOption[], modes: { currentModeId: string; availableModes: { id: string }[] } | null | undefined, session: AiSession): Promise<void> {
    const desired = session.configuration ?? {};
    if (modes && typeof desired.mode === "string" && modes.currentModeId !== desired.mode && modes.availableModes.some((mode) => mode.id === desired.mode)) await connection.setSessionMode({ sessionId, modeId: desired.mode });
    for (const option of options) {
      const value = option.category === "model" ? session.model : option.category === "thought_level" ? session.reasoning : desired[option.id];
      if (value === undefined || value === option.currentValue) continue;
      await connection.setSessionConfigOption(option.type === "boolean" ? { sessionId, configId: option.id, type: "boolean", value: Boolean(value) } : { sessionId, configId: option.id, value: String(value) });
    }
  }

  private async consumeUpdate(workspace: string, params: SessionNotification): Promise<void> {
    const update = params.update; const session = await this.get(workspace);
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") this.appendChunk(session, update.messageId, update.content.text);
    else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") this.appendActivity(session, update.messageId, `Reasoning\n${update.content.text}`);
    else if (update.sessionUpdate === "tool_call") session.messages.push({ id: update.toolCallId, role: "activity", text: `${update.title}${update.status ? `\n${update.status}` : ""}`, timestamp: new Date().toISOString() });
    else if (update.sessionUpdate === "tool_call_update") { const item = session.messages.find((message) => message.id === update.toolCallId); if (item) item.text = `${update.title ?? item.text.split("\n")[0]}${update.status ? `\n${update.status}` : ""}`; }
    else if (update.sessionUpdate === "plan") session.messages.push(this.message("activity", `Plan\n${update.entries.map((entry) => `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`).join("\n")}`));
    else if (update.sessionUpdate === "usage_update") session.configuration = { ...session.configuration, _usageUsed: update.used, ...(update.size !== undefined ? { _usageLimit: update.size } : {}) };
    await this.save(workspace, session); this.onChanged(workspace);
  }

  private toUiOptions(options: SessionConfigOption[], modes: { currentModeId: string; availableModes: { id: string; name?: string; description?: string | null }[] } | null | undefined) {
    const mapped = options.filter((option) => option.category !== "model" && option.category !== "thought_level").map((option) => ({ id: option.id, name: option.name, description: option.description ?? "Configuration advertised by the ACP agent.", section: "acp", type: option.type, defaultValue: option.currentValue, ...(option.type === "select" ? { choices: option.options.flatMap((item) => "options" in item ? item.options : [item]).map((item) => ({ value: item.value, name: item.name, description: item.description ?? undefined })) } : {}) }));
    if (modes) mapped.unshift({ id: "mode", name: "Agent mode", description: "Controls the ACP agent's operating mode for this session.", section: "acp", type: "select" as const, defaultValue: modes.currentModeId, choices: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name ?? mode.id, description: mode.description ?? undefined })) });
    return mapped;
  }

  private appendChunk(session: AiSession, id: string | null | undefined, text: string): void { const key = id ?? crypto.randomUUID(); const existing = session.messages.find((message) => message.id === key); if (existing) existing.text += text; else session.messages.push({ id: key, role: "assistant", text, timestamp: new Date().toISOString() }); }
  private appendActivity(session: AiSession, id: string | null | undefined, text: string): void { const key = id ?? crypto.randomUUID(); const existing = session.messages.find((message) => message.id === key); if (existing) existing.text += text.replace(/^Reasoning\n/, ""); else session.messages.push({ id: key, role: "activity", text, timestamp: new Date().toISOString() }); }
  private mcpServers(servers?: AcpSendRequest["mcpServers"]): McpServer[] { return (servers ?? []).filter((server) => server.enabled !== false).map((server) => ({ name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) })); }
  private message(role: AiMessage["role"], text: string): AiMessage { return { id: crypto.randomUUID(), role, text, timestamp: new Date().toISOString() }; }
  private file(workspace: string): string { return path.join(this.stateDirectory, `${crypto.createHash("sha256").update(workspace).digest("hex")}-${this.descriptor.id}.json`); }
  private async save(workspace: string, session: AiSession): Promise<void> {
    const serialized = `${JSON.stringify({ ...session, messages: session.messages.slice(-1000) }, null, 2)}\n`;
    const previous = this.saveQueues.get(workspace) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.stateDirectory, { recursive: true });
      const file = this.file(workspace);
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, serialized);
      await rename(temp, file);
    });
    this.saveQueues.set(workspace, next);
    try { await next; } finally { if (this.saveQueues.get(workspace) === next) this.saveQueues.delete(workspace); }
  }
  private queue(workspace: string, operation: () => Promise<void>): Promise<void> { const next = (this.queues.get(workspace) ?? Promise.resolve()).catch(() => undefined).then(operation); this.queues.set(workspace, next); return next.finally(() => { if (this.queues.get(workspace) === next) this.queues.delete(workspace); }); }
  private async closeRuntime(workspace: string): Promise<void> { const runtime = this.runtimes.get(workspace); if (!runtime) return; this.runtimes.delete(workspace); runtime.child.stdin.end(); runtime.child.kill("SIGTERM"); }
  private async runtimeFailed(workspace: string, message: string): Promise<void> { const session = await this.get(workspace); if (session.status === "in_progress") { session.status = "error"; session.messages.push(this.message("error", message)); await this.save(workspace, session); this.onChanged(workspace); } }
}
