import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { AcpV2Connection, v2McpServers } from "./acp-v2.js";

type Message = Record<string, any>;
/** A scripted ACP v2 agent on in-memory streams: `on` answers requests, `emit` sends notifications. */
function fakeAgent(on: (message: Message, agent: { emit(method: string, params: Message): void; request(method: string, params: Message): Promise<any> }) => unknown) {
  const toAgent = new PassThrough(); const toClient = new PassThrough();
  const pending = new Map<number, (result: any) => void>(); let next = 1000;
  const write = (message: Message) => toClient.write(`${JSON.stringify(message)}\n`);
  const agent = {
    emit: (method: string, params: Message) => write({ jsonrpc: "2.0", method, params }),
    request: (method: string, params: Message) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); write({ jsonrpc: "2.0", id, method, params }); })
  };
  let buffer = "";
  toAgent.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (!message.method) { pending.get(message.id)?.(message.result); continue; }
      void Promise.resolve(on(message, agent)).then((result) => { if (message.id !== undefined) write(result instanceof Error ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: result.message } } : { jsonrpc: "2.0", id: message.id, result: result ?? {} }); });
    }
  });
  return { toAgent, toClient, close: () => toClient.end() };
}
const client = () => ({ sessionUpdate: vi.fn(async () => {}), requestPermission: vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "allow" } })), createElicitation: vi.fn(async () => ({ action: "cancel" })) });
const initialize = { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } }, clientInfo: { name: "Vibe Editor", version: "0.1.0" } } as never;
const updates = (handlers: ReturnType<typeof client>) => (handlers.sessionUpdate.mock.calls as unknown as [{ update: Message }][]).map(([notification]) => notification.update);

it("negotiates v2, maps config options and modes, and ends a prompt on the idle state", async () => {
  const handlers = client();
  const agent = fakeAgent(async (message, peer) => {
    if (message.method === "initialize") { expect(message.params).toMatchObject({ protocolVersion: 2, info: { name: "Vibe Editor" }, capabilities: { auth: { terminal: true } } }); return { protocolVersion: 2, info: { name: "fake", version: "1" }, capabilities: { session: { prompt: { image: true } } }, authMethods: [] }; }
    if (message.method === "session/new") return { sessionId: "s1", configOptions: [{ configId: "mode", category: "mode", type: "select", currentValue: "agent", options: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Agent" }] }] };
    if (message.method === "session/set_config_option") return { configOptions: [{ configId: "mode", category: "mode", type: "select", currentValue: message.params.value, options: [] }] };
    if (message.method === "session/prompt") {
      setTimeout(() => {
        const update = (value: Message) => peer.emit("session/update", { sessionId: "s1", update: value });
        update({ sessionUpdate: "state_update", state: "running" });
        update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hel" } });
        update({ sessionUpdate: "agent_message", messageId: "m1", content: [{ type: "text", text: "Hello!" }] });
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "read", status: "in_progress" });
        update({ sessionUpdate: "tool_call_content_chunk", toolCallId: "t1", content: { type: "content", content: { type: "text", text: "a" } } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
        update({ sessionUpdate: "terminal_output_chunk", terminalId: "x", data: "ignored" });
        update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 } });
      }, 5);
      return { messageId: "u1" };
    }
  });
  const connection = new AcpV2Connection(handlers as never, agent.toAgent, agent.toClient);
  const initialized = await connection.initialize(initialize);
  expect(initialized.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: true } });
  const session = await connection.newSession({ cwd: "/workspace", mcpServers: [] });
  expect(session).toMatchObject({ sessionId: "s1", configOptions: [{ id: "mode", configId: "mode" }], modes: { currentModeId: "agent", availableModes: [{ id: "read-only", name: "Read only" }, { id: "agent", name: "Agent" }] } });
  await connection.setSessionMode({ sessionId: "s1", modeId: "read-only" });
  await expect(connection.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "hi" }] })).resolves.toEqual({ stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 } });
  await vi.waitFor(() => expect(handlers.sessionUpdate).toHaveBeenCalledTimes(5));
  // Whole-message upserts become the missing delta; the first tool upsert becomes v1's tool_call; agent terminals are dropped.
  expect(updates(handlers)).toEqual([
    { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hel" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "lo!" } },
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", status: "in_progress", content: [] },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "a" } }] },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }
  ]);
});

it("translates permission subjects and rejects turns that end with an error", async () => {
  const handlers = client();
  const agent = fakeAgent(async (message, peer) => {
    if (message.method === "initialize") return { protocolVersion: 2, capabilities: {}, authMethods: [] };
    if (message.method === "session/new") return { sessionId: "s1" };
    if (message.method === "session/prompt") {
      const tool = await peer.request("session/request_permission", { sessionId: "s1", title: "Edit file", subject: { type: "tool_call", toolCall: { toolCallId: "t1", kind: "edit" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
      const command = await peer.request("session/request_permission", { sessionId: "s1", title: "Run npm test", description: "Runs the test suite", subject: { type: "command", command: "npm test", cwd: "/workspace" }, options: [] });
      peer.emit("session/update", { sessionId: "s1", update: { sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { message: `quota exceeded after ${tool.outcome.optionId}/${command.outcome.optionId}` } } });
      return { messageId: "u1" };
    }
  });
  const connection = new AcpV2Connection(handlers as never, agent.toAgent, agent.toClient);
  await connection.initialize(initialize);
  await connection.newSession({ cwd: "/workspace", mcpServers: [] });
  await expect(connection.prompt({ sessionId: "s1", prompt: [] })).rejects.toThrow("quota exceeded after allow/allow");
  const [first, second] = (handlers.requestPermission.mock.calls as unknown as [Message][]).map(([request]) => request);
  expect(first).toEqual({ sessionId: "s1", toolCall: { toolCallId: "t1", kind: "edit", title: "Edit file" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
  expect(second).toMatchObject({ toolCall: { toolCallId: "command-1", title: "Run npm test", kind: "execute", rawInput: { command: "npm test", cwd: "/workspace" }, content: [{ type: "content", content: { type: "text", text: "Runs the test suite" } }] } });
});

it("refuses agents that only negotiate v1 and fails pending work when the agent exits", async () => {
  const v1 = fakeAgent((message) => message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : undefined);
  await expect(new AcpV2Connection(client() as never, v1.toAgent, v1.toClient).initialize(initialize)).rejects.toThrow("does not support ACP v2");
  const silent = fakeAgent(() => new Promise(() => {}));
  const connection = new AcpV2Connection(client() as never, silent.toAgent, silent.toClient);
  const pending = connection.newSession({ cwd: "/workspace", mcpServers: [] });
  silent.close();
  await expect(pending).rejects.toThrow("closed the connection");
});

it("types stdio MCP servers for v2 and leaves out SSE servers, which v2 does not support", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(v2McpServers([
    { name: "vibe-skills", command: "node", args: ["server.js"], env: [] },
    { type: "http", name: "remote", url: "https://example.com/mcp", headers: [] },
    { type: "sse", name: "legacy", url: "https://example.com/sse", headers: [] }
  ])).toEqual([{ type: "stdio", name: "vibe-skills", command: "node", args: ["server.js"], env: [] }, { type: "http", name: "remote", url: "https://example.com/mcp", headers: [] }]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy uses SSE"));
  warn.mockRestore();
});
