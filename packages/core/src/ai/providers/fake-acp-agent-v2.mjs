// Minimal experimental draft ACP v2 agent for provider tests. FAKE_V2_ONLY_V1=1 makes it negotiate v1.
import readline from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const options = (model = "model-a") => [{ configId: "model", category: "model", type: "select", name: "Model", currentValue: model, options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] }];
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method || message.id === undefined) return;
  const ok = (result) => send({ id: message.id, result });
  if (message.method === "initialize") return ok({ protocolVersion: process.env.FAKE_V2_ONLY_V1 === "1" ? 1 : 2, info: { name: "fake-v2", version: "1" }, capabilities: { session: {} }, authMethods: [] });
  // Like real v2 agents, reject MCP servers without a transport `type` (v1 leaves stdio untyped).
  if ((message.method === "session/new" || message.method === "session/resume") && (message.params.mcpServers ?? []).some((server) => !server.type)) return send({ id: message.id, error: { code: -32602, message: "Invalid params" } });
  if (message.method === "session/new") { if (process.env.FAKE_V2_REQUIRE_MCP === "1" && !(message.params.mcpServers ?? []).length) return send({ id: message.id, error: { code: -32602, message: "Expected Vibe MCP servers" } }); return ok({ sessionId: "v2-session", configOptions: options() }); }
  if (message.method === "session/resume") return ok({ configOptions: options() });
  if (message.method === "session/set_config_option") return ok({ configOptions: options(message.params.value) });
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId; const text = message.params.prompt.map((block) => block.text ?? "").join(""); const id = `m${++turn}`;
    ok({ messageId: `u${turn}` });
    update(sessionId, { sessionUpdate: "state_update", state: "running" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: "Hello" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `tool-${turn}`, title: "Run echo", kind: "execute", status: "in_progress", rawInput: { command: "echo hi" } });
    update(sessionId, { sessionUpdate: "tool_call_content_chunk", toolCallId: `tool-${turn}`, content: { type: "content", content: { type: "text", text: "hi" } } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `tool-${turn}`, status: "completed" });
    update(sessionId, { sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: `Hello from v2${process.env.FAKE_SECRET ? " (secret visible)" : ""}: ${text}` }] });
    update(sessionId, { sessionUpdate: "usage_update", used: 120, size: 1000 });
    setTimeout(() => update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } }), 20);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
});
