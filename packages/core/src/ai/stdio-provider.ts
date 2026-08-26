import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client, type McpServer, type SessionConfigOption, type SessionNotification } from "@agentclientprotocol/sdk";
import { AcpProvider, applyConfiguration, type AcpSendRequest, type AiConfiguration, type AiMessage, type AiModel, type AiOption, type AiProviderDescriptor, type AiSession, type AiUsage } from "@remote-ide/acp";
import { CoreError } from "../errors.js";

type ToolState = { title: string; status?: string; command?: string; body: string[] };
type Runtime = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessionId: string;
  running: boolean;
  stderr: string;
  session: AiSession;
  tools: Map<string, ToolState>;
  anchors: { assistant?: string; thought?: string };
};
type ModeState = { currentModeId: string; availableModes: { id: string; name?: string; description?: string | null }[] } | null | undefined;
type ModelState = { currentModelId?: string; availableModels: { modelId: string; name: string; description?: string | null }[] } | null | undefined;
type CreatedSession = { sessionId: string; configOptions?: SessionConfigOption[] | null; modes?: ModeState; models?: ModelState };
type Connected = { child: ChildProcessWithoutNullStreams; connection: ClientSideConnection; sessionId: string; stderr(): string; configOptions: SessionConfigOption[]; modes: ModeState; models: ModelState; bind(runtime: Runtime): void };

const MODEL_CACHE_MS = 5 * 60_000;

/** Genuine ACP v1 client transport over NDJSON/stdio. */
export abstract class StdioAcpProvider extends AcpProvider {
  abstract readonly descriptor: AiProviderDescriptor;
  protected abstract command(configuration: AiConfiguration): { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  protected abstract fallbackModels(): Promise<AiModel[]>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private modelCache?: { at: number; models: AiModel[] };
  private modelDiscovery?: Promise<AiModel[]>;
  private lastWorkspace = process.cwd();

  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) { super(); }

  async get(workspace: string): Promise<AiSession> {
    const live = this.runtimes.get(workspace);
    if (live) return { ...live.session, messages: live.session.messages.slice(-1000) };
    try {
      const saved = JSON.parse(await readFile(this.file(workspace), "utf8")) as AiSession;
      return { ...saved, model: saved.model ?? "auto", reasoning: saved.reasoning ?? "medium", status: saved.status === "in_progress" ? "error" : saved.status, messages: Array.isArray(saved.messages) ? saved.messages.slice(-1000) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: "auto", reasoning: "medium", status: "idle", messages: [] };
      throw new CoreError("READ_FAILED", `Could not load ${this.descriptor.name} session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Model catalogue advertised by the live ACP agent, including the reasoning
   * levels that each individual model accepts. Falls back to a static list only
   * when the agent cannot be reached.
   */
  async models(): Promise<AiModel[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.models;
    this.modelDiscovery ??= this.discoverModels().finally(() => { this.modelDiscovery = undefined; });
    const discovered = await this.modelDiscovery.catch(() => [] as AiModel[]);
    if (discovered.length > 0) { this.modelCache = { at: Date.now(), models: discovered }; return discovered; }
    return this.modelCache?.models ?? this.fallbackModels();
  }

  async configure(workspace: string, configuration: AiConfiguration | string, legacyReasoning?: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is currently working`);
    await this.closeRuntime(workspace);
    const session = await this.get(workspace); applyConfiguration(session, typeof configuration === "string" ? { model: configuration, reasoning: legacyReasoning ?? session.reasoning } : configuration);
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async send(workspace: string, request: AcpSendRequest): Promise<AiSession> {
    if (!request.prompt.trim() || request.prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is already working`);
    const session = await this.get(workspace);
    applyConfiguration(session, request.configuration);
    const runtime = await this.ensureRuntime(workspace, session, request.mcpServers);
    runtime.running = true;
    runtime.anchors = {};
    runtime.session.status = "in_progress";
    runtime.session.messages.push(this.message("user", request.prompt.trim()));
    await this.save(workspace, runtime.session); this.onChanged(workspace);
    const prompt = request.agent ? `${request.agent.instructions.trim()}\n\n${request.prompt.trim()}` : request.prompt.trim();
    // The completion handlers go through the same queue as `session/update` so a
    // final status never overtakes text the agent streamed just before it.
    void runtime.connection.prompt({ sessionId: runtime.sessionId, prompt: [{ type: "text", text: prompt }] }).then((result) => this.queue(workspace, async () => {
      runtime.running = false; runtime.anchors = {};
      const usage = result.usage;
      if (usage) runtime.session.tokens = { total: usage.totalTokens, input: usage.inputTokens, output: usage.outputTokens, ...(usage.thoughtTokens != null ? { thought: usage.thoughtTokens } : {}), ...(usage.cachedReadTokens != null ? { cachedRead: usage.cachedReadTokens } : {}), ...(usage.cachedWriteTokens != null ? { cachedWrite: usage.cachedWriteTokens } : {}) };
      runtime.session.status = result.stopReason === "cancelled" ? "idle" : result.stopReason === "end_turn" ? "done" : result.stopReason === "refusal" ? "error" : "user_prompt";
      if (result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests") runtime.session.messages.push(this.message("activity", `Turn stopped early: ${result.stopReason}`));
      if (result.stopReason === "refusal") runtime.session.messages.push(this.message("error", "The agent refused to continue this turn."));
      await this.save(workspace, runtime.session); this.onChanged(workspace);
    })).catch((error: unknown) => this.queue(workspace, async () => {
      runtime.running = false; runtime.anchors = {};
      runtime.session.status = "error"; runtime.session.messages.push(this.message("error", this.describe(error, runtime)));
      await this.save(workspace, runtime.session); this.onChanged(workspace);
    }));
    return this.get(workspace);
  }

  async interrupt(workspace: string): Promise<AiSession> {
    const runtime = this.runtimes.get(workspace);
    if (!runtime?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is not currently working`);
    await runtime.connection.cancel({ sessionId: runtime.sessionId });
    runtime.running = false; runtime.anchors = {};
    runtime.session.status = "idle"; runtime.session.messages.push(this.message("activity", "Interrupted by user"));
    await this.save(workspace, runtime.session); this.onChanged(workspace); return this.get(workspace);
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is still working`);
    await this.closeRuntime(workspace);
    const current = await this.get(workspace);
    const session: AiSession = { model: current.model, reasoning: current.reasoning, configuration: current.configuration, availableOptions: current.availableOptions, status: "idle", messages: [] };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async usage(workspace?: string): Promise<AiUsage> {
    const session = await this.get(workspace ?? this.lastWorkspace).catch(() => undefined);
    const tokens = session?.tokens;
    const details: Record<string, string | number> = {};
    if (tokens) {
      details.input = tokens.input; details.output = tokens.output; details.total = tokens.total;
      if (tokens.thought != null) details.reasoning = tokens.thought;
      if (tokens.cachedRead != null) details["cache read"] = tokens.cachedRead;
      if (tokens.cachedWrite != null) details["cache write"] = tokens.cachedWrite;
    }
    const extra = Object.keys(details).length > 0 ? { details } : {};
    if (session?.contextUsed === undefined) return { supported: Object.keys(details).length > 0, label: Object.keys(details).length > 0 ? "Tokens used by the latest turn" : "The agent has not reported usage yet.", ...extra };
    return { supported: true, label: "Context window", used: session.contextUsed, ...(session.contextLimit !== undefined ? { limit: session.contextLimit } : {}), unit: "tokens", ...extra };
  }

  private async ensureRuntime(workspace: string, session: AiSession, servers?: AcpSendRequest["mcpServers"]): Promise<Runtime> {
    const existing = this.runtimes.get(workspace);
    if (existing) { applyConfiguration(existing.session, session.configuration ?? {}); return existing; }
    this.lastWorkspace = workspace;
    const connected = await this.connect(workspace, session.configuration ?? {}, servers);
    const runtime: Runtime = { child: connected.child, connection: connected.connection, sessionId: connected.sessionId, running: false, stderr: connected.stderr(), session, tools: new Map(), anchors: {} };
    connected.bind(runtime);
    session.threadId = connected.sessionId;
    session.availableOptions = this.toUiOptions(connected.configOptions, connected.modes);
    this.runtimes.set(workspace, runtime);
    const warnings = await this.applyAcpConfiguration(runtime, connected.configOptions, connected.modes);
    if (warnings.length > 0) session.messages.push(this.message("activity", `Session configuration\n${warnings.join("\n")}`));
    await this.save(workspace, session);
    return runtime;
  }

  /** Spawns the agent, performs the ACP handshake and opens a session. */
  private async connect(workspace: string, configuration: AiConfiguration, servers?: AcpSendRequest["mcpServers"]): Promise<Connected> {
    const launch = this.command(configuration);
    const child = spawn(launch.command, launch.args, { cwd: workspace, env: { ...process.env, ...launch.env }, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    let bound: ((params: SessionNotification) => Promise<void> | void) | undefined;
    const client: Client = {
      requestPermission: (params) => { const allowed = params.options.find((option) => option.kind === "allow_once") ?? params.options.find((option) => option.kind === "allow_always"); return allowed ? { outcome: { outcome: "selected", optionId: allowed.optionId } } : { outcome: { outcome: "cancelled" } }; },
      sessionUpdate: (params) => bound?.(params)
    };
    const connection = new ClientSideConnection(() => client, stream);
    let authHint = "";
    try {
      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "Vibe Editor", version: "0.1.0" } });
      authHint = initialized.authMethods?.map((method) => method.description ?? method.name).join("; ") ?? "";
      const created = await connection.newSession({ cwd: workspace, mcpServers: this.mcpServers(servers) }) as CreatedSession;
      const configOptions = created.configOptions ?? [];
      this.rememberModels(configOptions, created.models);
      return {
        child, connection, sessionId: created.sessionId, stderr: () => stderr, configOptions, modes: created.modes, models: created.models,
        bind: (runtime) => {
          child.stderr.on("data", () => { runtime.stderr = stderr; });
          bound = (params) => this.queue(workspace, () => this.consumeUpdate(workspace, runtime, params));
          child.on("error", (error) => { void this.runtimeFailed(workspace, error.message); });
          child.on("close", (code) => { if (this.runtimes.get(workspace) === runtime) { this.runtimes.delete(workspace); void this.runtimeFailed(workspace, stderr.trim() || `${this.descriptor.name} ACP server exited with code ${code ?? 1}`); } });
        }
      };
    } catch (error) {
      child.kill("SIGTERM");
      const message = error instanceof Error ? error.message : String(error);
      throw new CoreError("TERMINAL_FAILED", `Could not start ${this.descriptor.name} ACP server: ${message}${/auth/i.test(message) && authHint ? `. ${authHint}` : ""}${stderr ? ` (${stderr.trim()})` : ""}`);
    }
  }

  /**
   * Applies the persisted configuration through ACP. The model is applied before
   * the reasoning effort because agents re-advertise the effort levels that the
   * newly selected model accepts, and applying an unsupported level is a hard
   * error that would otherwise abort the whole session.
   */
  private async applyAcpConfiguration(runtime: Runtime, options: SessionConfigOption[], modes: ModeState): Promise<string[]> {
    const session = runtime.session;
    const desired = session.configuration ?? {};
    const warnings: string[] = [];
    let current = options;
    const attempt = async (option: SessionConfigOption, value: string | number | boolean | undefined): Promise<void> => {
      if (value === undefined || value === "" || value === option.currentValue) return;
      try {
        if (option.type === "boolean") { await runtime.connection.setSessionConfigOption({ sessionId: runtime.sessionId, configId: option.id, type: "boolean", value: Boolean(value) }); return; }
        if (!selectValues(option).includes(String(value))) { warnings.push(`• ${option.name}: "${value}" is not offered by ${this.descriptor.name}, keeping "${option.currentValue}".`); return; }
        const response = await runtime.connection.setSessionConfigOption({ sessionId: runtime.sessionId, configId: option.id, value: String(value) });
        if (response.configOptions) current = response.configOptions;
      } catch (error) { warnings.push(`• ${option.name}: ${error instanceof Error ? error.message : String(error)}`); }
    };

    const modeOption = current.find((option) => option.category === "mode");
    if (modeOption) await attempt(modeOption, desired.mode);
    else if (modes && typeof desired.mode === "string" && modes.currentModeId !== desired.mode && modes.availableModes.some((mode) => mode.id === desired.mode)) await runtime.connection.setSessionMode({ sessionId: runtime.sessionId, modeId: desired.mode }).catch((error: unknown) => { warnings.push(`• Agent mode: ${error instanceof Error ? error.message : String(error)}`); });

    const modelOption = current.find((option) => option.category === "model");
    if (modelOption) await attempt(modelOption, session.model);

    const thoughtOption = current.find((option) => option.category === "thought_level");
    if (thoughtOption) await attempt(thoughtOption, session.reasoning);
    else session.reasoning = "";

    for (const option of current) {
      if (option.category === "mode" || option.category === "model" || option.category === "thought_level") continue;
      await attempt(option, desired[option.id]);
    }
    this.syncFromOptions(session, current, modes);
    return warnings;
  }

  private async consumeUpdate(workspace: string, runtime: Runtime, params: SessionNotification): Promise<void> {
    const update = params.update;
    const session = runtime.session;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update.content); if (!text) break;
        runtime.anchors.assistant = this.appendChunk(session, "assistant", update.messageId ?? runtime.anchors.assistant, text);
        runtime.anchors.thought = undefined;
        break;
      }
      case "agent_thought_chunk": {
        const text = textOf(update.content); if (!text) break;
        runtime.anchors.thought = this.appendChunk(session, "activity", update.messageId ?? runtime.anchors.thought, text, "Reasoning");
        runtime.anchors.assistant = undefined;
        break;
      }
      case "tool_call": {
        runtime.anchors = {};
        const tool: ToolState = { title: update.title, status: update.status ?? undefined, ...toolBody(update) };
        runtime.tools.set(update.toolCallId, tool);
        session.messages.push({ id: update.toolCallId, role: "activity", text: renderTool(tool), timestamp: new Date().toISOString() });
        break;
      }
      case "tool_call_update": {
        const tool = runtime.tools.get(update.toolCallId) ?? { title: update.title ?? "Tool call", body: [] };
        if (update.title) tool.title = update.title;
        if (update.status) tool.status = update.status;
        const next = toolBody(update);
        if (next.command) tool.command = next.command;
        if (next.body.length > 0) tool.body = next.body;
        runtime.tools.set(update.toolCallId, tool);
        const existing = session.messages.find((message) => message.id === update.toolCallId);
        if (existing) existing.text = renderTool(tool);
        else session.messages.push({ id: update.toolCallId, role: "activity", text: renderTool(tool), timestamp: new Date().toISOString() });
        break;
      }
      case "plan": case "plan_update": {
        const entries = "entries" in update && Array.isArray(update.entries) ? update.entries : [];
        if (entries.length === 0) break;
        runtime.anchors = {};
        session.messages.push(this.message("activity", `Plan\n${entries.map((entry) => `${entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "•"} ${entry.content}`).join("\n")}`));
        break;
      }
      case "current_mode_update": session.configuration = { ...session.configuration, mode: update.currentModeId }; break;
      case "config_option_update": this.syncFromOptions(session, update.configOptions ?? [], undefined); break;
      case "usage_update": session.contextUsed = update.used; if (update.size != null) session.contextLimit = update.size; break;
      case "compaction_update": session.messages.push(this.message("activity", "Compacting conversation history")); break;
      default: break;
    }
    await this.save(workspace, session); this.onChanged(workspace);
  }

  /** Mirrors the agent's authoritative option state onto the session and model cache. */
  private syncFromOptions(session: AiSession, options: SessionConfigOption[], modes: ModeState): void {
    if (options.length === 0) return;
    session.availableOptions = this.toUiOptions(options, modes);
    const model = options.find((option) => option.category === "model");
    if (model) session.model = String(model.currentValue);
    const thought = options.find((option) => option.category === "thought_level");
    session.reasoning = thought ? String(thought.currentValue) : "";
    const mode = options.find((option) => option.category === "mode");
    session.configuration = { ...session.configuration, model: session.model, reasoning: session.reasoning, ...(mode ? { mode: String(mode.currentValue) } : {}) };
    this.rememberModels(options);
    this.rememberEffort(session.model, options);
  }

  /** Opens a throwaway ACP session purely to read the agent's model catalogue. */
  private async discoverModels(): Promise<AiModel[]> {
    let connected: Connected | undefined;
    try {
      connected = await this.connect(this.lastWorkspace, {});
      const option = connected.configOptions.find((item) => item.category === "model");
      const advertised = option ? selectOptions(option) : (connected.models?.availableModels ?? []).map((model) => ({ value: model.modelId, name: model.name }));
      if (advertised.length === 0) return [];
      if (!option || option.type !== "select") return advertised.map((item) => ({ id: item.value, name: item.name, defaultReasoning: "", reasoningLevels: [] }));
      const models: AiModel[] = [];
      for (const item of advertised) {
        let reasoningLevels: string[] = [];
        let defaultReasoning = "";
        try {
          const response = await connected.connection.setSessionConfigOption({ sessionId: connected.sessionId, configId: option.id, value: item.value });
          const thought = (response.configOptions ?? []).find((candidate) => candidate.category === "thought_level");
          if (thought) { reasoningLevels = selectValues(thought); defaultReasoning = String(thought.currentValue); }
        } catch { /* the agent rejected this model; still list it, without reasoning levels */ }
        models.push({ id: item.value, name: item.name, defaultReasoning, reasoningLevels });
      }
      return models;
    } finally { connected?.child.stdin.end(); connected?.child.kill("SIGTERM"); }
  }

  private rememberModels(options: SessionConfigOption[], models?: ModelState): void {
    const option = options.find((item) => item.category === "model");
    const advertised = option ? selectOptions(option) : (models?.availableModels ?? []).map((model) => ({ value: model.modelId, name: model.name }));
    if (advertised.length === 0) return;
    const known = new Map((this.modelCache?.models ?? []).map((model) => [model.id, model] as const));
    this.modelCache = { at: this.modelCache?.at ?? 0, models: advertised.map((item) => known.get(item.value) ?? { id: item.value, name: item.name, defaultReasoning: "", reasoningLevels: [] }) };
  }

  private rememberEffort(modelId: string, options: SessionConfigOption[]): void {
    const entry = this.modelCache?.models.find((model) => model.id === modelId);
    if (!entry) return;
    const thought = options.find((option) => option.category === "thought_level");
    if (thought) { entry.reasoningLevels = selectValues(thought); entry.defaultReasoning = String(thought.currentValue); }
    else { entry.reasoningLevels = []; entry.defaultReasoning = ""; }
  }

  private toUiOptions(options: SessionConfigOption[], modes: ModeState): AiOption[] {
    const mapped: AiOption[] = options.filter((option) => option.category !== "model" && option.category !== "thought_level").map((option) => ({ id: option.id, name: option.name, description: option.description ?? "Configuration advertised by the ACP agent.", section: "acp", type: option.type, defaultValue: option.currentValue, ...(option.type === "select" ? { choices: selectOptions(option) } : {}) }));
    if (modes && !options.some((option) => option.category === "mode")) mapped.unshift({ id: "mode", name: "Agent mode", description: "Controls the ACP agent's operating mode for this session.", section: "acp", type: "select", defaultValue: modes.currentModeId, choices: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name ?? mode.id, description: mode.description ?? undefined })) });
    return mapped;
  }

  /**
   * Appends streamed text to the message currently being built. Agents are free
   * to omit `messageId` (Copilot always does), so chunks are anchored to the
   * message the turn is streaming into instead of starting a new bubble each time.
   */
  private appendChunk(session: AiSession, role: AiMessage["role"], anchor: string | undefined, text: string, heading?: string): string {
    const existing = anchor ? session.messages.find((message) => message.id === anchor && message.role === role) : undefined;
    if (existing) { existing.text += text; return existing.id; }
    const id = anchor ?? crypto.randomUUID();
    session.messages.push({ id, role, text: heading ? `${heading}\n${text}` : text, timestamp: new Date().toISOString() });
    return id;
  }

  /** Turns a JSON-RPC failure into something a user can act on. */
  private describe(error: unknown, runtime: Runtime): string {
    const parts: string[] = [];
    const message = error instanceof Error ? error.message : String(error);
    parts.push(message);
    const data = (error as { data?: unknown } | null)?.data;
    if (typeof data === "string" && data.trim() && !message.includes(data.trim())) parts.push(data.trim());
    else if (data && typeof data === "object") { const detail = (data as { details?: unknown; message?: unknown }).details ?? (data as { message?: unknown }).message; if (typeof detail === "string" && detail.trim() && !message.includes(detail.trim())) parts.push(detail.trim()); }
    const stderr = runtime.stderr.trim();
    if (stderr && !parts.some((part) => part.includes(stderr))) parts.push(stderr.slice(-2000));
    // Agents frequently stream the reason as normal output and then fail the
    // request with the same text; do not show the user the same wall twice.
    const recent = runtime.session.messages.slice(-3).map((item) => item.text).join("\n");
    const unseen = parts.filter((part) => part.length > 0 && !recent.includes(part));
    return (unseen.length > 0 ? unseen : parts.slice(0, 1)).join("\n");
  }

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

function selectOptions(option: SessionConfigOption): { value: string; name: string; description?: string }[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => ("options" in item ? item.options : [item])).map((item) => ({ value: item.value, name: item.name, description: item.description ?? undefined }));
}

function selectValues(option: SessionConfigOption): string[] { return selectOptions(option).map((item) => item.value); }

function textOf(content: { type: string; text?: string }): string { return content.type === "text" ? content.text ?? "" : ""; }

function toolBody(update: { rawInput?: unknown; content?: unknown }): { command?: string; body: string[] } {
  const lines: string[] = [];
  const input = update.rawInput as Record<string, unknown> | undefined;
  const command = input && typeof input.command === "string" ? input.command : undefined;
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const entry = item as { type?: string; content?: { type?: string; text?: string }; path?: string; newText?: string; terminalId?: string };
    if (entry.type === "content" && entry.content?.type === "text" && entry.content.text) lines.push(entry.content.text);
    else if (entry.type === "diff" && entry.path) lines.push(`--- ${entry.path}\n${entry.newText ?? ""}`);
    else if (entry.type === "terminal" && entry.terminalId) lines.push(`terminal ${entry.terminalId}`);
  }
  return command === undefined ? { body: lines } : { command, body: lines };
}

function renderTool(tool: ToolState): string {
  const heading = tool.status && tool.status !== "completed" ? `${tool.title} (${tool.status})` : tool.title;
  return [heading, ...(tool.command ? [`$ ${tool.command}`] : []), ...tool.body].join("\n");
}
