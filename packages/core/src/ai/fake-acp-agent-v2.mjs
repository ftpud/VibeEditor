// Minimal experimental draft ACP v2 agent for provider tests. FAKE_V2_ONLY_V1=1 makes it negotiate v1.
import readline from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const configFeedback = process.env.FAKE_CONFIG_FEEDBACK === "on";
let configWrites = 0;
let selectedModel = "model-a";
const options = (model = selectedModel) => [{ configId: "model", category: "model", type: "select", name: "Model", currentValue: model, options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] }, ...(configFeedback ? [{ configId: "reasoning_effort", category: "thought_level", type: "select", name: "Reasoning", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] }] : [])];
let turn = 0;
let active = false;
const steering = process.env.FAKE_V2_STEERING === "on";
const promptQueueing = process.env.FAKE_V2_STEERING === "prompt";
// "queue": like Claude, a prompt sent mid-turn waits; the turn goes idle and the queued prompt starts at once.
const queueNext = process.env.FAKE_V2_STEERING === "queue";
const queued = [];
let oauthAttempts = 0;
const failOAuth = (message) => {
  if (process.env.FAKE_OAUTH_STAGE !== (message.method === "session/new" ? "new" : "prompt")) return false;
  if (++oauthAttempts > Number(process.env.FAKE_OAUTH_FAILURES ?? 0)) return false;
  process.stderr.write("[session/create] sessionId=fake phase=settings durationMs=12\n[session/query] sessionId=fake resume=none\n[authStatus] discarding a probe that predates the latest auth change\n");
  if (process.env.FAKE_OAUTH_OUTPUT === "on") update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "partial", content: { type: "text", text: "Work already started" } });
  const text = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. Retry in a minute.";
  send({ id: message.id, error: { code: -32603, message: text } });
  return true;
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method || message.id === undefined) return;
  const ok = (result) => send({ id: message.id, result });
  if (message.method === "initialize") return ok({ protocolVersion: process.env.FAKE_V2_ONLY_V1 === "1" ? 1 : 2, info: { name: "fake-v2", version: "1" }, capabilities: { session: {} }, authMethods: [], ...(steering ? { _meta: { steering: { supported: true } } } : {}) });
  if (["session/new", "session/prompt"].includes(message.method) && failOAuth(message)) return;
  // Like real v2 agents, reject MCP servers without a transport `type` (v1 leaves stdio untyped).
  if ((message.method === "session/new" || message.method === "session/resume") && (message.params.mcpServers ?? []).some((server) => !server.type)) return send({ id: message.id, error: { code: -32602, message: "Invalid params" } });
  if (message.method === "session/new") { if (process.env.FAKE_V2_REQUIRE_MCP === "1" && !(message.params.mcpServers ?? []).length) return send({ id: message.id, error: { code: -32602, message: "Expected Vibe MCP servers" } }); return ok({ sessionId: "v2-session", configOptions: options() }); }
  if (message.method === "session/resume") return ok({ configOptions: options() });
  if (message.method === "session/set_config_option") {
    // Real v2 agents require the value `type` discriminator.
    if (!["id", "boolean"].includes(message.params.type)) return send({ id: message.id, error: { code: -32602, message: "Invalid params" } });
    if (!configFeedback) return ok({ configOptions: options(message.params.value) });
    configWrites++;
    if (configWrites > 8) return send({ id: message.id, error: { code: -32602, message: "Configuration feedback loop" } });
    if (message.params.configId === "model") selectedModel = message.params.value;
    update(message.params.sessionId, { sessionUpdate: "config_option_update", configOptions: options() });
    if (message.params.configId === "reasoning_effort") return send({ id: message.id, error: { code: -32602, message: "Invalid reasoning parameter" } });
    return ok({ configOptions: options() });
  }
  if (message.method === "_session/steering" && steering && active) {
    ok({ outcome: "injected" });
    update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: `m${turn}`, content: { type: "text", text: `[steered: ${message.params.prompt[0].text}]` } });
    setTimeout(() => { active = false; update(message.params.sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }); }, 20);
    return;
  }
  if (message.method === "session/prompt") {
    if (queueNext && active) { ok({ messageId: "queued-user" }); queued.push({ sessionId: message.params.sessionId, text: message.params.prompt.map((block) => block.text ?? "").join("") }); return; }
    if (steering && active) return send({ id: message.id, error: { code: -32600, message: "Use the advertised steering extension during an active turn" } });
    if (promptQueueing && active) {
      ok({ messageId: "steered-user" });
      update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: `m${turn}`, content: { type: "text", text: `[steered: ${message.params.prompt[0].text}]` } });
      setTimeout(() => { active = false; update(message.params.sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }); }, 20);
      return;
    }
    if (configFeedback) update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: `config-writes-${turn}`, content: { type: "text", text: `Configuration writes: ${configWrites}` } });
    active = true;
    const sessionId = message.params.sessionId; const text = message.params.prompt.map((block) => block.text ?? "").join(""); const id = `m${++turn}`;
    ok({ messageId: `u${turn}` });
    update(sessionId, { sessionUpdate: "state_update", state: "running" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: "Hello" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `tool-${turn}`, title: "Run echo", kind: "execute", status: "in_progress", rawInput: { command: "echo hi" } });
    update(sessionId, { sessionUpdate: "tool_call_content_chunk", toolCallId: `tool-${turn}`, content: { type: "content", content: { type: "text", text: "hi" } } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `tool-${turn}`, status: "completed" });
    update(sessionId, { sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: `Hello from v2${process.env.FAKE_SECRET ? " (secret visible)" : ""}: ${text}` }] });
    update(sessionId, { sessionUpdate: "usage_update", used: 120, size: 1000 });
    if (!steering && !promptQueueing) setTimeout(() => {
      active = false; update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } });
      const next = queued.shift();
      if (!next) return;
      // The queued prompt starts the instant the previous turn is idle, with no gap for the client to settle it.
      active = true;
      update(sessionId, { sessionUpdate: "state_update", state: "running" });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "queued-tool", title: "Queued work", kind: "execute", status: "in_progress" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "queued-answer", content: { type: "text", text: `Answering queued: ${next.text}` } });
      setTimeout(() => { active = false; update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }); }, 60);
    }, queueNext ? 200 : 20);
    // FAKE_V2_AGENT_TURN=1: after the first turn goes idle, resume by itself as if background work finished.
    if (process.env.FAKE_V2_AGENT_TURN === "1" && turn === 1) setTimeout(() => {
      update(sessionId, { sessionUpdate: "state_update", state: "running" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "background", content: { type: "text", text: "Background build finished" } });
      setTimeout(() => update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }), 20);
    }, 100);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
});
