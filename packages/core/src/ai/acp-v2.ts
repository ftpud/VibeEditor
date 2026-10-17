import type { Readable, Writable } from "node:stream";
import type {
  AuthenticateRequest, AuthenticateResponse, CancelNotification, Client, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
  NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, RequestPermissionRequest, SessionNotification, SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse
} from "@agentclientprotocol/sdk";

/** The draft protocol version this client requests in `initialize`. */
export const ACP_V2_PROTOCOL_VERSION = 2;
type Json = Record<string, any>;
type Waiter = { resolve(result: PromptResponse): void; reject(error: Error): void };
type SessionState = { idle: Waiter[]; agentTurn: boolean; tools: Map<string, unknown[]>; text: Map<string, string>; configOptions: Json[]; nextCommand: number };
/**
 * Turns the agent starts without a `session/prompt`, for example once background
 * work it ended its previous turn waiting on has finished. v1 has no counterpart.
 * Both are called in order with the session's translated updates.
 */
export type AcpV2AgentTurns = { started(sessionId: string): void; ended(sessionId: string, result: PromptResponse | Error): void };

/**
 * Experimental draft ACP v2 client with the subset of `ClientSideConnection`'s
 * v1 API that Vibe uses, so the provider runtime is shared by both protocols.
 *
 * v2 differs mainly in its turn lifecycle: `session/prompt` only acknowledges
 * the prompt, and a turn ends with an `idle` `state_update`. An agent may also
 * start a turn of its own while idle (`running` with no prompt waiting), which
 * is reported through `AcpV2AgentTurns`. Tool calls are
 * upserts, messages may be sent whole, modes are config options, and config
 * options use `configId`. Incoming v2 messages are translated to their v1
 * equivalents for the existing `Client` handlers.
 *
 * The draft still changes between SDK releases (agents ship different
 * snapshots), so messages are parsed leniently instead of validated against one
 * snapshot's schema.
 */
export class AcpV2Connection {
  readonly protocolVersion = ACP_V2_PROTOCOL_VERSION;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly sessions = new Map<string, SessionState>();
  private buffer = "";
  private closed?: Error;

  constructor(private readonly client: Client, private readonly output: Writable, input: Readable, private readonly agentTurns?: AcpV2AgentTurns) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    const close = () => this.close(new Error("The ACP v2 agent closed the connection"));
    input.once("end", close); input.once("close", close);
    output.on("error", (error: Error) => this.close(error));
  }

  // --- v1-shaped API used by the provider -------------------------------------------------------

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const capabilities = params.clientCapabilities as Json | undefined;
    const result = await this.request("initialize", { protocolVersion: ACP_V2_PROTOCOL_VERSION, info: params.clientInfo, capabilities: { ...(capabilities?.auth ? { auth: capabilities.auth } : {}), ...(capabilities?.elicitation ? { elicitation: capabilities.elicitation } : {}) } });
    if (result?.protocolVersion !== ACP_V2_PROTOCOL_VERSION) throw new Error(`The agent does not support ACP v2 (it negotiated protocol ${String(result?.protocolVersion)}). Switch this provider to ACP v1, or install an adapter build with ACP v2 support.`);
    const session = (result.capabilities?.session ?? {}) as Json;
    // Resume is baseline in v2; it replaces v1's `session/load`.
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, ...(session.prompt ? { promptCapabilities: session.prompt } : {}), ...(session.mcp ? { mcpCapabilities: session.mcp } : {}), ...(result.capabilities?._meta ? { _meta: result.capabilities._meta } : {}) }, authMethods: result.authMethods ?? [], ...(result.info ? { agentInfo: result.info } : {}), ...(result._meta ? { _meta: result._meta } : {}) } as InitializeResponse;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const result = await this.request("session/new", { cwd: params.cwd, mcpServers: v2McpServers(params.mcpServers), ...(params._meta ? { _meta: params._meta } : {}) });
    return { sessionId: result.sessionId, ...this.sessionOptions(result.sessionId, result.configOptions) } as NewSessionResponse;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.request("session/resume", { sessionId: params.sessionId, cwd: params.cwd, mcpServers: v2McpServers(params.mcpServers), replayFrom: { type: "start" }, ...(params._meta ? { _meta: params._meta } : {}) });
    return this.sessionOptions(params.sessionId, result?.configOptions) as LoadSessionResponse;
  }

  /** Resolves when the session next becomes idle, which ends the turn this prompt joined. */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.session(params.sessionId);
    // Wait before sending: the idle update may arrive before the prompt's acknowledgement.
    let waiter!: Waiter;
    const done = new Promise<PromptResponse>((resolve, reject) => { waiter = { resolve, reject }; state.idle.push(waiter); });
    try { await this.request("session/prompt", { sessionId: params.sessionId, prompt: params.prompt, ...(params._meta ? { _meta: params._meta } : {}) }); }
    catch (error) { state.idle = state.idle.filter((item) => item !== waiter); void done.catch(() => {}); throw error; }
    return done;
  }

  async cancel(params: CancelNotification): Promise<void> { this.notify("session/cancel", { sessionId: params.sessionId }); }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    // v2 discriminates the value by `type`; v1-shaped select requests omit it and are rejected as invalid params.
    const result = await this.request("session/set_config_option", { ...params, type: "type" in params ? params.type : "id" } as unknown as Json);
    return { configOptions: this.rememberOptions(params.sessionId, result?.configOptions) } as SetSessionConfigOptionResponse;
  }

  /** v2 has no session modes: they are the config option in the `mode` category. */
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const option = this.session(params.sessionId).configOptions.find((item) => item.category === "mode");
    if (!option) throw new Error("This agent does not offer session modes over ACP v2");
    await this.setSessionConfigOption({ sessionId: params.sessionId, configId: option.id, value: params.modeId } as SetSessionConfigOptionRequest);
    return {};
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> { return (await this.request("auth/login", { methodId: params.methodId })) ?? {}; }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> { return (await this.request(method, params)) ?? {}; }

  // --- v2 → v1 translation -------------------------------------------------------------------

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) { state = { idle: [], agentTurn: false, tools: new Map(), text: new Map(), configOptions: [], nextCommand: 0 }; this.sessions.set(sessionId, state); }
    return state;
  }
  private rememberOptions(sessionId: string, options: unknown): Json[] {
    const state = this.session(sessionId);
    if (Array.isArray(options)) state.configOptions = options.map((option: Json) => ({ ...option, id: option.id ?? option.configId }));
    return state.configOptions;
  }
  private sessionOptions(sessionId: string, options: unknown): { configOptions: Json[]; modes?: Json } {
    const configOptions = this.rememberOptions(sessionId, options);
    const mode = configOptions.find((item) => item.category === "mode" && Array.isArray(item.options));
    return { configOptions, ...(mode ? { modes: { currentModeId: mode.currentValue, availableModes: (mode.options as Json[]).map((choice) => ({ id: choice.value, name: choice.name ?? choice.value, ...(choice.description ? { description: choice.description } : {}) })) } } : {}) };
  }

  private translate(params: Json): Json[] {
    const sessionId = params.sessionId as string; const update = params.update as Json | undefined;
    if (!sessionId || !update) return [];
    const state = this.session(sessionId);
    const out = (sessionUpdate: Json) => ({ sessionId, update: sessionUpdate, ...(params._meta ? { _meta: params._meta } : {}) });
    switch (update.sessionUpdate) {
      case "state_update": {
        if (update.state === "running" || update.state === "requires_action") {
          // Work no prompt is waiting on is a turn the agent started by itself.
          if (!state.idle.length && !state.agentTurn) { state.agentTurn = true; this.agentTurns?.started(sessionId); }
          return [];
        }
        if (update.state !== "idle") return [];
        const waiters = state.idle.splice(0);
        const agentTurn = state.agentTurn; state.agentTurn = false;
        const stopReason = typeof update.stopReason === "string" ? update.stopReason : update.stopReason?.type ?? update.stopReason?.reason ?? "end_turn";
        const result = stopReason === "error" ? new Error(update.error?.message ?? update.stopReason?.error?.message ?? "The agent ended the turn with an error") : { stopReason, ...(update.usage ? { usage: update.usage } : {}) } as PromptResponse;
        for (const waiter of waiters) { if (result instanceof Error) waiter.reject(result); else waiter.resolve(result); }
        if (agentTurn) this.agentTurns?.ended(sessionId, result);
        return [];
      }
      case "agent_message_chunk": case "agent_thought_chunk": case "user_message_chunk": {
        const key = `${update.sessionUpdate}:${update.messageId ?? ""}`;
        state.text.set(key, (state.text.get(key) ?? "") + textOf([update.content]));
        return [out(update)];
      }
      // Whole-message upserts: forward only what extends the text already shown.
      case "agent_message": case "agent_thought": case "user_message": {
        const chunk = `${update.sessionUpdate}_chunk`; const key = `${chunk}:${update.messageId ?? ""}`;
        if (!Array.isArray(update.content)) return [];
        const text = textOf(update.content); const shown = state.text.get(key) ?? "";
        state.text.set(key, text);
        if (!text.startsWith(shown) || text.length === shown.length) return [];
        return [out({ sessionUpdate: chunk, ...(update.messageId ? { messageId: update.messageId } : {}), content: { type: "text", text: text.slice(shown.length) } })];
      }
      case "tool_call_update": {
        const { sessionUpdate: _type, name, ...fields } = update;
        if (!state.tools.has(update.toolCallId)) {
          state.tools.set(update.toolCallId, Array.isArray(update.content) ? [...update.content] : []);
          return [out({ ...fields, sessionUpdate: "tool_call", title: update.title ?? name ?? "Tool call", status: update.status ?? "pending", content: update.content ?? [] })];
        }
        if (update.content !== undefined) state.tools.set(update.toolCallId, Array.isArray(update.content) ? [...update.content] : []);
        return [out({ ...fields, sessionUpdate: "tool_call_update" })];
      }
      case "tool_call_content_chunk": {
        const known = state.tools.get(update.toolCallId);
        const content = [...known ?? [], update.content];
        state.tools.set(update.toolCallId, content);
        return known ? [out({ sessionUpdate: "tool_call_update", toolCallId: update.toolCallId, content })] : [out({ sessionUpdate: "tool_call", toolCallId: update.toolCallId, title: "Tool call", status: "in_progress", content })];
      }
      case "config_option_update": {
        const previous = this.session(sessionId).configOptions.find((item) => item.category === "mode")?.currentValue;
        const configOptions = this.rememberOptions(sessionId, update.configOptions);
        const mode = configOptions.find((item) => item.category === "mode")?.currentValue;
        return [out({ ...update, configOptions }), ...(mode !== undefined && mode !== previous ? [out({ sessionUpdate: "current_mode_update", currentModeId: mode })] : [])];
      }
      case "plan_update": case "plan_removed": case "available_commands_update": case "session_info_update": case "usage_update": case "notice": case "compaction_update": case "compaction_summary_chunk":
        return [out(update)];
      // Agent-owned terminals, subagents and other draft additions have no v1 counterpart yet.
      default: return [];
    }
  }

  private toPermission(params: Json): RequestPermissionRequest {
    const subject = (params.subject ?? {}) as Json; const state = this.session(params.sessionId);
    const description = params.description ? [{ type: "content", content: { type: "text", text: params.description } }] : [];
    const toolCall = subject.type === "tool_call" && subject.toolCall
      ? { ...subject.toolCall, title: subject.toolCall.title ?? params.title }
      : { toolCallId: subject.toolCallId ?? `command-${++state.nextCommand}`, title: params.title ?? "Permission requested", kind: subject.type === "command" ? "execute" : "other", ...(subject.command ? { rawInput: { command: subject.command, cwd: subject.cwd } } : {}), content: description };
    return { sessionId: params.sessionId, toolCall, options: params.options ?? [], ...(params._meta ? { _meta: params._meta } : {}) } as RequestPermissionRequest;
  }

  // --- JSON-RPC over newline-delimited JSON (batches allowed) -------------------------------

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      for (const item of Array.isArray(message) ? message : [message]) void this.dispatch(item as Json);
    }
  }
  private async dispatch(message: Json): Promise<void> {
    if (typeof message?.method === "string") {
      if (message.id === undefined) { if (message.method === "session/update") for (const notification of this.translate(message.params ?? {})) await this.client.sessionUpdate(notification as SessionNotification); return; }
      try { this.send({ jsonrpc: "2.0", id: message.id, result: await this.handle(message.method, message.params ?? {}) }); }
      catch (error) { this.send({ jsonrpc: "2.0", id: message.id, error: { code: (error as { code?: number }).code ?? -32603, message: error instanceof Error ? error.message : String(error) } }); }
      return;
    }
    const waiter = typeof message?.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? "ACP v2 request failed"), { code: message.error.code, data: message.error.data }));
    else waiter.resolve(message.result);
  }
  private async handle(method: string, params: Json): Promise<unknown> {
    if (method === "session/request_permission") return this.client.requestPermission(this.toPermission(params));
    if (method === "elicitation/create" && this.client.createElicitation) return this.client.createElicitation(params as never);
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
  private request(method: string, params: Json): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ jsonrpc: "2.0", id, method, params }); });
  }
  private notify(method: string, params: Json): void { if (!this.closed) this.send({ jsonrpc: "2.0", method, params }); }
  private send(message: Json): void { this.output.write(`${JSON.stringify(message)}\n`); }
  private close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const state of this.sessions.values()) for (const waiter of state.idle.splice(0)) waiter.reject(error);
  }
}

/**
 * v2 requires a `type` on every MCP server, including `stdio` (v1 leaves stdio
 * untyped), and has no SSE transport.
 */
export function v2McpServers(servers: readonly unknown[] | undefined): Json[] {
  const result: Json[] = [];
  for (const server of (servers ?? []) as Json[]) {
    if (server.type === "sse") { console.warn(`[acp] MCP server ${String(server.name)} uses SSE, which ACP v2 does not support; it is not connected.`); continue; }
    result.push(server.type ? server : { type: "stdio", ...server });
  }
  return result;
}

function textOf(content: unknown[]): string { return content.map((block) => (block as Json)?.type === "text" ? String((block as Json).text ?? "") : "").join(""); }
