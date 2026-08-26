import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client, type ContentBlock, type McpServer, type RequestPermissionRequest, type RequestPermissionResponse, type SessionConfigOption, type SessionNotification } from "@agentclientprotocol/sdk";
import { AcpProvider, applyConfiguration, type AcpSendRequest, type AiConfiguration, type AiContentBlock, type AiMessage, type AiModel, type AiModelDetails, type AiOption, type AiProviderDescriptor, type AiSession, type AiUsage } from "@remote-ide/acp";
import { CoreError } from "../errors.js";

type ToolState = { title: string; status?: string; command?: string; body: string[]; content: AiContentBlock[] };
type Runtime = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessionId: string;
  running: boolean;
  stderr: string;
  session: AiSession;
  tools: Map<string, ToolState>;
  anchors: { assistant?: string; thought?: string };
  /** Bumped for every turn so a superseded turn cannot write a stale status. */
  generation: number;
  /** True when the agent implements the `_session/steering` extension. */
  steering: boolean;
  /** Follow-ups typed mid-turn that agents without steering run next. */
  pending: string[];
  configOptions: SessionConfigOption[];
  modes: ModeState;
  mcpKey: string;
};
type ModeState = { currentModeId: string; availableModes: { id: string; name?: string; description?: string | null }[] } | null | undefined;
type ModelState = { currentModelId?: string; availableModels: { modelId: string; name: string; description?: string | null; _meta?: Record<string, unknown> }[] } | null | undefined;
type SelectChoice = { value: string; name: string; description?: string; _meta?: Record<string, unknown> };
type CreatedSession = { sessionId: string; configOptions?: SessionConfigOption[] | null; modes?: ModeState; models?: ModelState };
type Connected = { child: ChildProcessWithoutNullStreams; connection: ClientSideConnection; sessionId: string; stderr(): string; configOptions: SessionConfigOption[]; modes: ModeState; models: ModelState; steering: boolean; resumed: boolean; resumeFailed: boolean; bind(runtime: Runtime): void };
type PermissionWaiter = { workspace: string; resolve(response: RequestPermissionResponse): void };

const STEERING_METHOD = "_session/steering";

function stamp(session: AiSession): number { return Date.parse(session.updatedAt ?? session.createdAt ?? "") || 0; }

/** Everything the session picker needs to label a conversation, without its transcript. */
function summarize(session: AiSession): AiSession {
  const first = session.messages?.find((message) => message.role === "user");
  return { ...session, pendingPermission: undefined, availableCommands: undefined, availableOptions: undefined, messages: first ? [first] : [] };
}

const MODEL_CACHE_MS = 5 * 60_000;
/** Archived sessions kept per workspace and provider. */
const ARCHIVE_LIMIT = 50;
const CONVERSATION_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "plan_update", "compaction_update"]);
const TERMINAL_ONLY_COMMANDS = new Set(["/diff", "/resume", "/theme", "/settings", "/login", "/help", "/tasks", "/undo"]);

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
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  private readonly blankSessions = new Map<string, AiSession>();
  private readonly archiveIndex = new Map<string, { at: number; sessions: AiSession[] }>();

  constructor(private readonly onChanged: (workspace: string) => void, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) { super(); }

  async get(workspace: string): Promise<AiSession> {
    const live = this.runtimes.get(workspace);
    if (live) return { ...live.session, messages: live.session.messages.slice(-1000) };
    try {
      const saved = JSON.parse(await readFile(this.file(workspace), "utf8")) as AiSession;
      const now = new Date().toISOString();
      return { ...saved, id: saved.id ?? crypto.randomUUID(), createdAt: saved.createdAt ?? now, updatedAt: saved.updatedAt ?? now, model: saved.model ?? "auto", reasoning: saved.reasoning ?? "medium", status: saved.status === "in_progress" ? "error" : saved.status, messages: Array.isArray(saved.messages) ? saved.messages.slice(-1000) : [] };
    } catch (error) {
      // A workspace that never talked to the agent still needs a stable id: minting a
      // fresh one on every `get` would make the client believe the session changed.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const pending = this.blankSessions.get(workspace) ?? this.emptySession();
        this.blankSessions.set(workspace, pending);
        return { ...pending, messages: [] };
      }
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
    if (discovered.length > 0) { const described = await this.describeModels(discovered); this.modelCache = { at: Date.now(), models: described }; return described; }
    return this.modelCache?.models ?? this.describeModels(await this.fallbackModels());
  }

  /**
   * Provider hook for catalogue facts the ACP handshake does not carry, such as
   * context window sizes the CLI keeps in its own model cache.
   */
  protected async describeModels(models: AiModel[]): Promise<AiModel[]> { return models; }

  async configure(workspace: string, configuration: AiConfiguration | string, legacyReasoning?: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is currently working`);
    const runtime = this.runtimes.get(workspace);
    const session = runtime?.session ?? await this.get(workspace);
    const desired = typeof configuration === "string" ? { model: configuration, reasoning: legacyReasoning ?? session.reasoning } : configuration;
    applyConfiguration(session, desired);
    if (runtime) {
      const warnings = await this.applyAcpConfiguration(runtime, runtime.configOptions, runtime.modes);
      if (warnings.length > 0) session.messages.push(this.message("activity", `Session configuration\n${warnings.join("\n")}`));
      const dynamic = new Set(["model", "reasoning", "mode", ...runtime.configOptions.map((option) => option.id)]);
      if (Object.keys(desired).some((key) => !dynamic.has(key))) await this.closeRuntime(workspace);
    }
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  async send(workspace: string, request: AcpSendRequest): Promise<AiSession> {
    const prompt = request.prompt.trim();
    const command = prompt.split(/\s/, 1)[0]?.toLowerCase();
    if (command && TERMINAL_ONLY_COMMANDS.has(command)) throw new CoreError("INVALID_REQUEST", `${command} is a terminal-only command. Use Vibe Editor's native controls instead.`);
    const content = this.promptContent(workspace, prompt, request.content);
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is already working`);
    const session = await this.get(workspace);
    applyConfiguration(session, request.configuration);
    const allowedServers = request.agent?.mcpServers ? request.mcpServers?.filter((server) => request.agent!.mcpServers!.includes(server.name)) : request.mcpServers;
    const runtime = await this.ensureRuntime(workspace, session, allowedServers);
    const visible = [prompt, ...(request.content ?? []).map(contentLabel)].filter(Boolean).join("\n");
    runtime.session.messages.push({ ...this.message("user", visible), content: request.content });
    if (request.agent?.instructions.trim()) content.unshift({ type: "text", text: request.agent.instructions.trim() });
    this.runPrompt(workspace, runtime, content);
    await this.save(workspace, runtime.session); this.onChanged(workspace);
    return this.get(workspace);
  }

  /**
   * Adds input to a turn that is already running. Agents implementing the
   * `_session/steering` extension fold it into the live turn; for the rest the
   * follow-up is queued and dispatched the moment the current turn ends.
   */
  async steer(workspace: string, text: string): Promise<AiSession> {
    const prompt = this.validate(text);
    const runtime = this.runtimes.get(workspace);
    if (!runtime?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is not currently working`);
    runtime.session.messages.push(this.message("user", prompt));
    runtime.anchors = {};
    if (runtime.steering) {
      try { await runtime.connection.extMethod(STEERING_METHOD, { sessionId: runtime.sessionId, prompt: [{ type: "text", text: prompt }] }); }
      catch (error) { runtime.session.messages.push(this.message("activity", `Could not steer the running turn, queued instead: ${error instanceof Error ? error.message : String(error)}`)); runtime.pending.push(prompt); }
    } else runtime.pending.push(prompt);
    await this.save(workspace, runtime.session); this.onChanged(workspace);
    return this.get(workspace);
  }

  async interrupt(workspace: string): Promise<AiSession> {
    const runtime = this.runtimes.get(workspace);
    if (!runtime?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is not currently working`);
    // Retire the turn before cancelling so neither its late output nor its
    // completion status (agents may still report `end_turn`) lands afterwards.
    runtime.generation += 1;
    runtime.running = false; runtime.anchors = {}; runtime.pending = [];
    try { await runtime.connection.cancel({ sessionId: runtime.sessionId }); }
    catch (error) { runtime.session.messages.push(this.message("activity", `Cancel request failed: ${error instanceof Error ? error.message : String(error)}`)); }
    runtime.session.status = "idle"; runtime.session.messages.push(this.message("activity", "Interrupted by user"));
    await this.save(workspace, runtime.session); this.onChanged(workspace); return this.get(workspace);
  }

  /** Starts a turn and wires its completion back onto the session. */
  private runPrompt(workspace: string, runtime: Runtime, prompt: ContentBlock[]): void {
    const generation = (runtime.generation += 1);
    runtime.running = true;
    runtime.anchors = {};
    runtime.session.status = "in_progress";
    // The completion handlers go through the same queue as `session/update` so a
    // final status never overtakes text the agent streamed just before it.
    void runtime.connection.prompt({ sessionId: runtime.sessionId, prompt }).then((result) => this.queue(workspace, async () => {
      if (runtime.generation !== generation) return;
      runtime.running = false; runtime.anchors = {};
      const usage = result.usage;
      if (usage) runtime.session.tokens = { total: usage.totalTokens, input: usage.inputTokens, output: usage.outputTokens, ...(usage.thoughtTokens != null ? { thought: usage.thoughtTokens } : {}), ...(usage.cachedReadTokens != null ? { cachedRead: usage.cachedReadTokens } : {}), ...(usage.cachedWriteTokens != null ? { cachedWrite: usage.cachedWriteTokens } : {}) };
      const queued = result.stopReason === "cancelled" ? undefined : runtime.pending.shift();
      if (queued !== undefined) this.runPrompt(workspace, runtime, [{ type: "text", text: queued }]);
      else {
        runtime.session.status = result.stopReason === "cancelled" ? "idle" : result.stopReason === "end_turn" ? "done" : result.stopReason === "refusal" ? "error" : "user_prompt";
        if (result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests") runtime.session.messages.push(this.message("activity", `Turn stopped early: ${result.stopReason}`));
        if (result.stopReason === "refusal") runtime.session.messages.push(this.message("error", "The agent refused to continue this turn."));
      }
      await this.save(workspace, runtime.session); this.onChanged(workspace);
    })).catch((error: unknown) => this.queue(workspace, async () => {
      if (runtime.generation !== generation) return;
      runtime.running = false; runtime.anchors = {}; runtime.pending = [];
      runtime.session.status = "error"; runtime.session.messages.push(this.message("error", this.describe(error, runtime)));
      await this.save(workspace, runtime.session); this.onChanged(workspace);
    }));
  }

  private validate(prompt: string): string {
    if (!prompt.trim() || prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    return prompt.trim();
  }

  private promptContent(workspace: string, prompt: string, blocks?: AiContentBlock[]): ContentBlock[] {
    if (prompt.length > 100_000) throw new CoreError("INVALID_REQUEST", "Prompt must contain at most 100,000 characters");
    const result: ContentBlock[] = prompt ? [{ type: "text", text: prompt }] : [];
    for (const block of blocks ?? []) {
      if (block.type === "text") result.push({ type: "text", text: block.text });
      else if (block.type === "image") result.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else if (block.type === "resource") result.push({ type: "resource", resource: { uri: block.uri, mimeType: block.mimeType, text: block.text } });
      else {
        let uri = block.uri;
        if (uri.startsWith("workspace:")) {
          const absolute = path.resolve(workspace, uri.slice("workspace:".length));
          const relative = path.relative(workspace, absolute);
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CoreError("INVALID_REQUEST", "Attached resource is outside the workspace");
          uri = pathToFileURL(absolute).href;
        }
        result.push({ type: "resource_link", uri, name: block.name, mimeType: block.mimeType, size: block.size });
      }
    }
    if (result.length === 0) throw new CoreError("INVALID_REQUEST", "Prompt or attachment is required");
    return result;
  }

  async resolvePermission(workspace: string, requestId: string, optionId?: string): Promise<AiSession> {
    const waiter = this.permissionWaiters.get(requestId);
    if (!waiter || waiter.workspace !== workspace) throw new CoreError("INVALID_REQUEST", "Permission request is no longer pending");
    const session = this.runtimes.get(workspace)?.session ?? await this.get(workspace);
    if (optionId && !session.pendingPermission?.options.some((option) => option.optionId === optionId)) throw new CoreError("INVALID_REQUEST", "Unknown permission option");
    this.permissionWaiters.delete(requestId);
    session.pendingPermission = undefined;
    waiter.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    await this.save(workspace, session); this.onChanged(workspace);
    return this.get(workspace);
  }

  async clear(workspace: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is still working`);
    await this.closeRuntime(workspace);
    const current = await this.get(workspace);
    await this.archive(workspace, current);
    const session: AiSession = { ...this.emptySession(), model: current.model, reasoning: current.reasoning, configuration: current.configuration, availableOptions: current.availableOptions };
    this.blankSessions.delete(workspace);
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  /** Active session first, then everything archived, most recently updated first. */
  async sessions(workspace: string): Promise<AiSession[]> {
    const current = await this.get(workspace).catch(() => undefined);
    const seen = new Set<string>();
    const result: AiSession[] = [];
    for (const session of [...(current ? [summarize(current)] : []), ...await this.index(workspace)]) {
      if (!session.id || seen.has(session.id)) continue;
      seen.add(session.id);
      result.push(session);
    }
    return result;
  }

  async restore(workspace: string, sessionId: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is still working`);
    const current = await this.get(workspace);
    if (current.id === sessionId) return current;
    const target = await this.readArchived(workspace, sessionId);
    if (!target) throw new CoreError("INVALID_REQUEST", "That session is no longer available");
    await this.closeRuntime(workspace);
    await this.archive(workspace, current);
    const restored: AiSession = { ...target, id: target.id ?? crypto.randomUUID(), createdAt: target.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), pendingPermission: undefined, status: target.status === "in_progress" ? "error" : target.status, messages: (target.messages ?? []).slice(-1000) };
    this.blankSessions.delete(workspace);
    await this.save(workspace, restored); this.onChanged(workspace); return restored;
  }

  async remove(workspace: string, sessionId: string): Promise<AiSession> {
    if (this.runtimes.get(workspace)?.running) throw new CoreError("INVALID_REQUEST", `${this.descriptor.name} is still working`);
    await rm(this.archiveFile(workspace, sessionId), { force: true });
    await this.cacheIndex(workspace, (await this.index(workspace)).filter((session) => session.id !== sessionId));
    const current = await this.get(workspace);
    if (current.id !== sessionId) { this.onChanged(workspace); return current; }
    // The removed session is the active one, so fall back to the newest remaining conversation.
    // It must not go through `clear`, which would archive the very session being removed.
    await this.closeRuntime(workspace);
    this.blankSessions.delete(workspace);
    const newest = (await this.index(workspace))[0]?.id;
    const next = newest ? await this.readArchived(workspace, newest) : undefined;
    const session: AiSession = next?.id
      ? { ...next, updatedAt: new Date().toISOString(), pendingPermission: undefined, status: next.status === "in_progress" ? "error" : next.status, messages: (next.messages ?? []).slice(-1000) }
      : { ...this.emptySession(), model: current.model, reasoning: current.reasoning, configuration: current.configuration, availableOptions: current.availableOptions };
    await this.save(workspace, session); this.onChanged(workspace); return session;
  }

  private archiveDirectory(workspace: string): string { return `${this.file(workspace).replace(/\.json$/, "")}-sessions`; }
  private archiveFile(workspace: string, sessionId: string): string { return path.join(this.archiveDirectory(workspace), `${sessionId.replace(/[^\w.-]/g, "_")}.json`); }

  /** Keeps a copy of a session that is about to stop being the active one. */
  private async archive(workspace: string, session: AiSession): Promise<void> {
    if (!session.id || session.messages.length === 0) return;
    const directory = this.archiveDirectory(workspace);
    await mkdir(directory, { recursive: true });
    const serialized = `${JSON.stringify({ ...session, pendingPermission: undefined, status: session.status === "in_progress" ? "error" : session.status, messages: session.messages.slice(-1000) }, null, 2)}\n`;
    const file = this.archiveFile(workspace, session.id);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, serialized);
    await rename(temp, file);
    const index = [summarize(session), ...(await this.index(workspace)).filter((entry) => entry.id !== session.id)].sort((left, right) => stamp(right) - stamp(left));
    await Promise.all(index.slice(ARCHIVE_LIMIT).map((entry) => rm(this.archiveFile(workspace, entry.id!), { force: true })));
    await this.cacheIndex(workspace, index.slice(0, ARCHIVE_LIMIT));
  }

  /**
   * Transcripts stay on disk and only the labels the picker needs are held in memory. The index is
   * rebuilt only when the archive directory has been touched since it was cached, so another core
   * process working on the same state directory cannot leave the listing stale.
   */
  private async index(workspace: string): Promise<AiSession[]> {
    const directory = this.archiveDirectory(workspace);
    const modified = await this.archiveStamp(workspace);
    const cached = this.archiveIndex.get(workspace);
    if (cached && cached.at === modified) return cached.sessions;
    let names: string[] = [];
    try { names = await readdir(directory); } catch { this.archiveIndex.set(workspace, { at: modified, sessions: [] }); return []; }
    const sessions = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try { return summarize(JSON.parse(await readFile(path.join(directory, name), "utf8")) as AiSession); } catch { return undefined; }
    }));
    const index = sessions.filter((session): session is AiSession => Boolean(session?.id)).sort((left, right) => stamp(right) - stamp(left));
    this.archiveIndex.set(workspace, { at: modified, sessions: index });
    return index;
  }

  private async archiveStamp(workspace: string): Promise<number> { return stat(this.archiveDirectory(workspace)).then((stats) => stats.mtimeMs).catch(() => 0); }
  private async cacheIndex(workspace: string, sessions: AiSession[]): Promise<void> { this.archiveIndex.set(workspace, { at: await this.archiveStamp(workspace), sessions }); }

  private async readArchived(workspace: string, sessionId: string): Promise<AiSession | undefined> {
    try {
      const session = JSON.parse(await readFile(this.archiveFile(workspace, sessionId), "utf8")) as AiSession;
      return session.id === sessionId ? session : undefined;
    } catch { return undefined; }
  }

  private emptySession(): AiSession {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, model: "auto", reasoning: "medium", status: "idle", messages: [] };
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
    let existing = this.runtimes.get(workspace);
    const mcpKey = JSON.stringify(this.mcpServers(servers));
    if (existing && servers !== undefined && existing.mcpKey !== mcpKey) { await this.closeRuntime(workspace); existing = undefined; }
    if (existing) {
      applyConfiguration(existing.session, session.configuration ?? {});
      const warnings = await this.applyAcpConfiguration(existing, existing.configOptions, existing.modes);
      if (warnings.length > 0) existing.session.messages.push(this.message("activity", `Session configuration\n${warnings.join("\n")}`));
      return existing;
    }
    this.lastWorkspace = workspace;
    const connected = await this.connect(workspace, session.configuration ?? {}, servers, session.threadId);
    if (connected.resumeFailed) session.messages.push(this.message("activity", "The saved ACP session could not be resumed; a new agent session was started."));
    const runtime: Runtime = { child: connected.child, connection: connected.connection, sessionId: connected.sessionId, running: false, stderr: connected.stderr(), session, tools: new Map(), anchors: {}, generation: 0, steering: connected.steering, pending: [], configOptions: connected.configOptions, modes: connected.modes, mcpKey };
    connected.bind(runtime);
    session.threadId = connected.sessionId;
    session.steering = connected.steering;
    session.availableOptions = this.toUiOptions(connected.configOptions, connected.modes);
    this.runtimes.set(workspace, runtime);
    const warnings = await this.applyAcpConfiguration(runtime, connected.configOptions, connected.modes);
    if (warnings.length > 0) session.messages.push(this.message("activity", `Session configuration\n${warnings.join("\n")}`));
    await this.save(workspace, session);
    return runtime;
  }

  /** Spawns the agent, performs the ACP handshake and opens a session. */
  private async connect(workspace: string, configuration: AiConfiguration, servers?: AcpSendRequest["mcpServers"], savedSessionId?: string): Promise<Connected> {
    const launch = this.command(configuration);
    const child = spawn(launch.command, launch.args, { cwd: workspace, env: { ...process.env, ...launch.env }, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    let bound: ((params: SessionNotification) => Promise<void> | void) | undefined;
    let permissionBound: ((params: RequestPermissionRequest) => Promise<RequestPermissionResponse>) | undefined;
    const buffered: SessionNotification[] = [];
    const client: Client = {
      requestPermission: (params) => permissionBound ? permissionBound(params) : { outcome: { outcome: "cancelled" } },
      sessionUpdate: (params) => { if (bound) return bound(params); buffered.push(params); }
    };
    const connection = new ClientSideConnection(() => client, stream);
    let authHint = "";
    try {
      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "Vibe Editor", version: "0.1.0" } });
      authHint = initialized.authMethods?.map((method) => method.description ?? method.name).join("; ") ?? "";
      const steering = (initialized._meta as { steering?: { supported?: boolean } } | undefined)?.steering?.supported === true;
      let created: CreatedSession;
      let resumed = false;
      let resumeFailed = false;
      if (savedSessionId && initialized.agentCapabilities?.loadSession) {
        try {
          const loaded = await connection.loadSession({ cwd: workspace, mcpServers: this.mcpServers(servers), sessionId: savedSessionId });
          created = { sessionId: savedSessionId, configOptions: loaded.configOptions, modes: loaded.modes };
          resumed = true;
        } catch {
          resumeFailed = true;
          created = await connection.newSession({ cwd: workspace, mcpServers: this.mcpServers(servers) }) as CreatedSession;
        }
      } else created = await connection.newSession({ cwd: workspace, mcpServers: this.mcpServers(servers) }) as CreatedSession;
      const configOptions = created.configOptions ?? [];
      this.rememberModels(configOptions, created.models);
      return {
        child, connection, sessionId: created.sessionId, stderr: () => stderr, configOptions, modes: created.modes, models: created.models, steering, resumed, resumeFailed,
        bind: (runtime) => {
          child.stderr.on("data", () => { runtime.stderr = stderr; });
          bound = (params) => this.queue(workspace, () => this.consumeUpdate(workspace, runtime, params));
          permissionBound = (params) => this.requestPermission(workspace, runtime, params);
          for (const params of buffered.splice(0)) {
            // Resuming replays the whole conversation. Those updates land after the freshly typed
            // prompt was already appended, which would push it to the top of the transcript, so the
            // replay is dropped in favour of the transcript we persisted for this session. Sessions
            // without a stored transcript (created outside the editor) still take the replay.
            if (resumed && runtime.session.messages.length > 0) continue;
            void bound(params);
          }
          child.on("error", (error) => { void this.runtimeFailed(workspace, error.message); });
          child.on("close", (code) => { if (this.runtimes.get(workspace) === runtime) { this.runtimes.delete(workspace); this.cancelPermissionWaiters(workspace); void this.runtimeFailed(workspace, stderr.trim() || `${this.descriptor.name} ACP server exited with code ${code ?? 1}`); } });
        }
      };
    } catch (error) {
      child.kill("SIGTERM");
      const message = error instanceof Error ? error.message : String(error);
      throw new CoreError("TERMINAL_FAILED", `Could not start ${this.descriptor.name} ACP server: ${message}${/auth/i.test(message) && authHint ? `. ${authHint}` : ""}${stderr ? ` (${stderr.trim()})` : ""}`);
    }
  }

  private async requestPermission(workspace: string, runtime: Runtime, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = crypto.randomUUID();
    const detail = toolBody(params.toolCall);
    runtime.session.pendingPermission = {
      id,
      title: params.toolCall.title ?? params.toolCall.name ?? "Permission required",
      toolCallId: params.toolCall.toolCallId,
      details: [detail.command ? `$ ${detail.command}` : "", ...detail.body].filter(Boolean).join("\n") || undefined,
      options: params.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
    };
    const response = new Promise<RequestPermissionResponse>((resolve) => { this.permissionWaiters.set(id, { workspace, resolve }); });
    await this.save(workspace, runtime.session); this.onChanged(workspace);
    return response;
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
    runtime.configOptions = current;
    runtime.modes = modes;
    return warnings;
  }

  private async consumeUpdate(workspace: string, runtime: Runtime, params: SessionNotification): Promise<void> {
    const update = params.update;
    const session = runtime.session;
    // Agents keep emitting output for a short while after a cancel; that trailing
    // text belongs to a turn the user already retired, so it is dropped.
    if (!runtime.running && runtime.generation > 0 && CONVERSATION_UPDATES.has(update.sessionUpdate)) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update.content);
        if (text) runtime.anchors.assistant = this.appendChunk(session, "assistant", update.messageId ?? runtime.anchors.assistant, text);
        else {
          const content = fromAcpContent(update.content);
          if (!content) break;
          runtime.anchors.assistant = undefined;
          session.messages.push({ ...this.message("assistant", contentLabel(content)), content: [content] });
        }
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
        session.messages.push({ id: update.toolCallId, role: "activity", text: renderTool(tool), content: tool.content, timestamp: new Date().toISOString() });
        break;
      }
      case "tool_call_update": {
        const tool = runtime.tools.get(update.toolCallId) ?? { title: update.title ?? "Tool call", body: [], content: [] };
        if (update.title) tool.title = update.title;
        if (update.status) tool.status = update.status;
        const next = toolBody(update);
        if (next.command) tool.command = next.command;
        if (next.body.length > 0) tool.body = next.body;
        if (next.content.length > 0) tool.content = next.content;
        runtime.tools.set(update.toolCallId, tool);
        const existing = session.messages.find((message) => message.id === update.toolCallId);
        if (existing) { existing.text = renderTool(tool); existing.content = tool.content; }
        else session.messages.push({ id: update.toolCallId, role: "activity", text: renderTool(tool), content: tool.content, timestamp: new Date().toISOString() });
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
      case "config_option_update": {
        runtime.configOptions = update.configOptions ?? [];
        const warnings = await this.applyAcpConfiguration(runtime, runtime.configOptions, runtime.modes);
        if (warnings.length > 0) session.messages.push(this.message("activity", `Session configuration\n${warnings.join("\n")}`));
        break;
      }
      case "available_commands_update": session.availableCommands = update.availableCommands.map((command) => ({ name: command.name, description: command.description, inputHint: command.input?.hint })); break;
      case "usage_update": session.contextUsed = update.used; if (update.size != null) { session.contextLimit = update.size; this.rememberContextWindow(session.model, update.size); } break;
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
      const advertised = option ? selectOptions(option) : (connected.models?.availableModels ?? []).map((model) => ({ value: model.modelId, name: model.name, description: model.description ?? undefined, _meta: model._meta }));
      if (advertised.length === 0) return [];
      if (!option || option.type !== "select") return advertised.map((item) => ({ id: item.value, name: item.name, defaultReasoning: "", reasoningLevels: [], ...modelDetails(item) }));
      const models: AiModel[] = [];
      for (const item of advertised) {
        let reasoningLevels: string[] = [];
        let defaultReasoning = "";
        let descriptions: Record<string, string> = {};
        try {
          const response = await connected.connection.setSessionConfigOption({ sessionId: connected.sessionId, configId: option.id, value: item.value });
          const thought = (response.configOptions ?? []).find((candidate) => candidate.category === "thought_level");
          if (thought) { reasoningLevels = selectValues(thought); defaultReasoning = String(thought.currentValue); descriptions = reasoningDescriptions(thought); }
        } catch { /* the agent rejected this model; still list it, without reasoning levels */ }
        models.push({ id: item.value, name: item.name, defaultReasoning, reasoningLevels, ...modelDetails(item), ...(Object.keys(descriptions).length > 0 ? { reasoningDescriptions: descriptions } : {}) });
      }
      return models;
    } finally { connected?.child.stdin.end(); connected?.child.kill("SIGTERM"); }
  }

  private rememberModels(options: SessionConfigOption[], models?: ModelState): void {
    const option = options.find((item) => item.category === "model");
    const advertised = option ? selectOptions(option) : (models?.availableModels ?? []).map((model) => ({ value: model.modelId, name: model.name, description: model.description ?? undefined, _meta: model._meta }));
    if (advertised.length === 0) return;
    const known = new Map((this.modelCache?.models ?? []).map((model) => [model.id, model] as const));
    this.modelCache = { at: this.modelCache?.at ?? 0, models: advertised.map((item) => ({ id: item.value, name: item.name, defaultReasoning: "", reasoningLevels: [], ...known.get(item.value), ...modelDetails(item) })) };
  }

  private rememberEffort(modelId: string, options: SessionConfigOption[]): void {
    const entry = this.modelCache?.models.find((model) => model.id === modelId);
    if (!entry) return;
    const thought = options.find((option) => option.category === "thought_level");
    if (thought) {
      entry.reasoningLevels = selectValues(thought); entry.defaultReasoning = String(thought.currentValue);
      const descriptions = reasoningDescriptions(thought);
      if (Object.keys(descriptions).length > 0) entry.reasoningDescriptions = descriptions;
    }
    else { entry.reasoningLevels = []; entry.defaultReasoning = ""; }
  }

  /** Agents report the live context window per turn; keep it on the selected model. */
  private rememberContextWindow(modelId: string, size: number): void {
    const entry = this.modelCache?.models.find((model) => model.id === modelId);
    if (entry && !entry.contextWindow) entry.contextWindow = size;
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

  private mcpServers(servers?: AcpSendRequest["mcpServers"]): McpServer[] {
    const result: McpServer[] = [];
    for (const server of servers ?? []) {
      if (server.enabled === false) continue;
      if ("url" in server) result.push({ type: server.transport, name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) });
      else result.push({ name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
    }
    return result;
  }
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
  private async closeRuntime(workspace: string): Promise<void> {
    const runtime = this.runtimes.get(workspace); if (!runtime) return;
    this.runtimes.delete(workspace);
    this.cancelPermissionWaiters(workspace);
    runtime.session.pendingPermission = undefined;
    runtime.child.stdin.end(); runtime.child.kill("SIGTERM");
  }
  private cancelPermissionWaiters(workspace: string): void { for (const [id, waiter] of this.permissionWaiters) if (waiter.workspace === workspace) { this.permissionWaiters.delete(id); waiter.resolve({ outcome: { outcome: "cancelled" } }); } }
  private async runtimeFailed(workspace: string, message: string): Promise<void> { const session = await this.get(workspace); session.pendingPermission = undefined; if (session.status === "in_progress") { session.status = "error"; session.messages.push(this.message("error", message)); await this.save(workspace, session); this.onChanged(workspace); } }
}

function selectOptions(option: SessionConfigOption): SelectChoice[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => ("options" in item ? item.options : [item])).map((item) => ({ value: item.value, name: item.name, description: item.description ?? undefined, _meta: (item as { _meta?: Record<string, unknown> })._meta }));
}

/**
 * Catalogue metadata agents publish next to a model. ACP itself only mandates an
 * id, name and description, so anything richer arrives through `_meta`; Copilot
 * advertises its premium-request multiplier and availability there.
 */
function modelDetails(choice: SelectChoice): AiModelDetails {
  const meta = choice._meta ?? {};
  const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const price = text(meta.copilotUsage) ?? text(meta.usage) ?? text(meta.price) ?? text(meta.multiplier);
  const tier = text(meta.copilotPriceCategory) ?? text(meta.priceCategory) ?? text(meta.priceTier);
  const enablement = text(meta.copilotEnablement) ?? text(meta.enablement);
  const contextWindow = typeof meta.contextWindow === "number" ? meta.contextWindow : undefined;
  return {
    // Agents commonly repeat the display name as the description; that is noise.
    ...(choice.description && choice.description !== choice.name ? { description: choice.description } : {}),
    ...(price ? { price } : {}),
    ...(tier ? { priceTier: tier } : {}),
    ...(enablement ? { available: enablement === "enabled" } : {}),
    ...(contextWindow ? { contextWindow } : {})
  };
}

/** Reasoning levels carry their own descriptions; keep them for the picker. */
function reasoningDescriptions(option: SessionConfigOption): Record<string, string> {
  const entries = selectOptions(option).filter((item) => item.description).map((item) => [item.value, item.description as string] as const);
  return Object.fromEntries(entries);
}

function selectValues(option: SessionConfigOption): string[] { return selectOptions(option).map((item) => item.value); }

function textOf(content: { type: string; text?: string }): string { return content.type === "text" ? content.text ?? "" : ""; }

function fromAcpContent(content: ContentBlock): AiContentBlock | undefined {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type === "image") return { type: "image", data: content.data, mimeType: content.mimeType };
  if (content.type === "resource_link") return { type: "resource_link", uri: content.uri, name: content.name, mimeType: content.mimeType ?? undefined, size: content.size ?? undefined };
  if (content.type === "resource" && "text" in content.resource) return { type: "resource", uri: content.resource.uri, mimeType: content.resource.mimeType ?? undefined, text: content.resource.text };
  return undefined;
}

function contentLabel(content: AiContentBlock): string {
  if (content.type === "text") return content.text;
  if (content.type === "image") return `[Image${content.name ? `: ${content.name}` : ""}]`;
  if (content.type === "resource") return `[Attached resource: ${content.name ?? content.uri}]`;
  return `[Workspace resource: ${content.name}]`;
}

function toolBody(update: { rawInput?: unknown; content?: unknown }): { command?: string; body: string[]; content: AiContentBlock[] } {
  const lines: string[] = [];
  const content: AiContentBlock[] = [];
  const input = update.rawInput as Record<string, unknown> | undefined;
  const command = input && typeof input.command === "string" ? input.command : undefined;
  for (const key of ["path", "filePath", "url", "scope"] as const) if (input && typeof input[key] === "string") lines.push(`${key}: ${input[key]}`);
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const entry = item as { type?: string; content?: { type?: string; text?: string }; path?: string; newText?: string; terminalId?: string };
    if (entry.type === "content" && entry.content?.type === "text" && entry.content.text) lines.push(entry.content.text);
    else if (entry.type === "content" && entry.content?.type === "image") { const block = fromAcpContent(entry.content as ContentBlock); if (block) content.push(block); lines.push("[Image output]"); }
    else if (entry.type === "diff" && entry.path) lines.push(`--- ${entry.path}\n${entry.newText ?? ""}`);
    else if (entry.type === "terminal" && entry.terminalId) lines.push(`terminal ${entry.terminalId}`);
  }
  return command === undefined ? { body: lines, content } : { command, body: lines, content };
}

function renderTool(tool: ToolState): string {
  const heading = tool.status && tool.status !== "completed" ? `${tool.title} (${tool.status})` : tool.title;
  return [heading, ...(tool.command ? [`$ ${tool.command}`] : []), ...tool.body].join("\n");
}
