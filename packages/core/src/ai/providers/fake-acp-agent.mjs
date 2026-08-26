// Minimal ACP v1 agent used by the provider tests. Speaks NDJSON JSON-RPC on stdio.
import readline from "node:readline";

const MODELS = { "model-a": ["low", "medium", "high"], "model-b": [] };
const STEERING = process.env.FAKE_STEERING === "on";
const SLOW = process.env.FAKE_SLOW === "on";
let live = null;
let model = "model-a";
let effort = "medium";
let cancelled = false;

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const options = () => [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: model, options: Object.keys(MODELS).map((id) => ({ value: id, name: id.toUpperCase() })) },
  ...(MODELS[model].length > 0 ? [{ type: "select", id: "reasoning_effort", name: "Reasoning", category: "thought_level", currentValue: effort, options: MODELS[model].map((value) => ({ value, name: value })) }] : []),
  { type: "select", id: "allow_all", name: "Allow all", category: "permissions", currentValue: "off", options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] }
];

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const ok = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  const fail = (message) => send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } });
  if (request.method === "initialize") return ok({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "1" }, _meta: STEERING ? { steering: { supported: true } } : undefined });
  if (request.method === "session/new") return ok({ sessionId: "fake-session", modes: null, configOptions: options() });
  if (request.method === "session/set_config_option") {
    const { configId, value } = request.params;
    if (configId === "model") { if (!MODELS[value]) return fail(`unknown model ${value}`); model = value; effort = MODELS[value][1] ?? ""; return ok({ configOptions: options() }); }
    if (configId === "reasoning_effort") { if (MODELS[model].length === 0) return fail("The selected model does not support reasoning_effort configuration."); effort = value; return ok({ configOptions: options() }); }
    return ok({ configOptions: options() });
  }
  if (request.method === "_session/steering") {
    if (!live) return ok({ outcome: "startedNewTurn" });
    notify(live, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[steered: ${request.params.prompt[0].text}]` } });
    return ok({ outcome: "injected" });
  }
  if (request.method === "session/cancel") { if (live) { notify(live, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "trailing output after cancel" } }); cancelled = true; } return; }
  if (request.method === "session/prompt") {
    const id = request.params.sessionId;
    live = id;
    cancelled = false;
    if (SLOW) {
      notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
      for (let i = 0; i < 100 && !cancelled; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      live = null;
      // Mirrors Copilot: a cancelled turn still reports `end_turn`.
      return ok({ stopReason: "end_turn" });
    }
    notify(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking " } });
    notify(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hard" } });
    for (const text of ["Hello", ", ", "world"]) notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    notify(id, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run echo", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    notify(id, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
    for (const text of ["Done", "!"]) notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    notify(id, { sessionUpdate: "usage_update", used: 120, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    live = null;
    return ok({ stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, thoughtTokens: 4 } });
  }
  if (request.id !== undefined) ok({});
});
