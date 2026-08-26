import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiConfiguration, AiModel, AiProviderDescriptor, AiSession } from "@remote-ide/acp";
import { CodexSessionManager } from "./codex.js";
import { CopilotSessionManager } from "./copilot.js";
import { StdioAcpProvider } from "../stdio-provider.js";
import { AcpRegistry } from "../acp.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.py", import.meta.url));

class FakeProvider extends StdioAcpProvider {
  constructor(onChanged: (workspace: string) => void, state: string, private readonly env: NodeJS.ProcessEnv = {}) { super(onChanged, state); }
  readonly descriptor: AiProviderDescriptor = { id: "fake", name: "Fake ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true } };
  protected command(_configuration: AiConfiguration) { return { command: "python3", args: [FAKE_AGENT], env: this.env }; }
  protected async fallbackModels(): Promise<AiModel[]> { return [{ id: "fallback", name: "Fallback", defaultReasoning: "medium", reasoningLevels: ["medium"] }]; }
}

async function settle(provider: FakeProvider, workspace: string): Promise<AiSession> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await provider.get(workspace);
    if (session.status !== "in_progress") return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the fake agent never finished the turn");
}

describe("ACP integration", () => {
  it("persists model settings independently by provider and workspace", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-settings-"));
    const workspace = "/workspace/one";
    const codex = new CodexSessionManager(() => undefined, state);
    const copilot = new CopilotSessionManager(() => undefined, state);
    await codex.configure(workspace, "gpt-test", "high");
    await copilot.configure(workspace, "claude-test", "low");
    expect(await codex.get(workspace)).toMatchObject({ model: "gpt-test", reasoning: "high" });
    expect(await copilot.get(workspace)).toMatchObject({ model: "claude-test", reasoning: "low" });
    expect(await copilot.get("/workspace/two")).toMatchObject({ model: "auto", reasoning: "medium" });
  });

  it("serializes concurrent ACP session saves", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-concurrent-"));
    const provider = new CodexSessionManager(() => undefined, state);
    await Promise.all(Array.from({ length: 20 }, (_, index) => provider.configure("/workspace/concurrent", { model: `model-${index}`, reasoning: "medium" })));
    expect((await provider.get("/workspace/concurrent")).model).toMatch(/^model-\d+$/);
  });

  it("discovers providers through the ACP registry and rejects unknown plugins", () => {
    const registry = new AcpRegistry().register(new CodexSessionManager(() => undefined));
    expect(registry.list().map((provider) => provider.id)).toEqual(["codex"]);
    expect(() => registry.get("missing")).toThrow("Unknown AI provider");
  });

  it("coalesces streamed chunks that carry no message id into one message per segment", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-stream-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: { model: "model-a", reasoning: "high" } });
    const session = await settle(provider, workspace);
    const assistant = session.messages.filter((message) => message.role === "assistant");
    expect(assistant.map((message) => message.text)).toEqual(["Hello, world", "Done!"]);
    const reasoning = session.messages.filter((message) => message.text.startsWith("Reasoning"));
    expect(reasoning.map((message) => message.text)).toEqual(["Reasoning\nthinking hard"]);
    const tool = session.messages.find((message) => message.id === "tool-1");
    expect(tool?.text).toBe("Run echo\n$ echo hi\nhi");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "activity", "assistant", "activity", "assistant"]);
    expect(session.status).toBe("done");
    expect(session.contextUsed).toBe(120);
    expect(session.contextLimit).toBe(1000);
    expect(session.tokens).toEqual({ total: 30, input: 20, output: 10, thought: 4 });
    await provider.clear(workspace);
  });

  it("reads the model catalogue, pricing metadata and per-model reasoning levels from the live agent", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-models-"));
    const provider = new FakeProvider(() => undefined, state);
    expect(await provider.models()).toEqual([
      { id: "model-a", name: "MODEL-A", description: "Fast test model", price: "0.33x", priceTier: "low", available: true, defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"], reasoningDescriptions: { low: "low effort", medium: "medium effort", high: "high effort" } },
      { id: "model-b", name: "MODEL-B", price: "10x", priceTier: "high", available: false, defaultReasoning: "", reasoningLevels: [] }
    ]);
  });

  it("keeps the session alive when the selected model rejects a reasoning effort", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-effort-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: { model: "model-b", reasoning: "high" } });
    const session = await settle(provider, workspace);
    expect(session.status).toBe("done");
    expect(session.reasoning).toBe("");
    expect(session.messages.some((message) => message.role === "error")).toBe(false);
    expect(session.availableOptions?.map((option) => option.id)).toEqual(["allow_all"]);
    await provider.clear(workspace);
  });

  it("reports token usage for the latest turn", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-usage-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    expect(await provider.usage(workspace)).toMatchObject({ supported: false });
    await provider.send(workspace, { prompt: "hello", configuration: { model: "model-a", reasoning: "low" } });
    await settle(provider, workspace);
    expect(await provider.usage(workspace)).toMatchObject({ supported: true, used: 120, limit: 1000, unit: "tokens", details: { input: 20, output: 10, total: 30, reasoning: 4 } });
    await provider.clear(workspace);
  });

  it("passes server-scoped Copilot model and reasoning configuration at launch", () => {
    const command = new CopilotSessionManager(() => undefined)["command"]({ model: "claude-haiku-4.5", reasoning: "medium", maxAiCredits: 5 });
    expect(command.args).toEqual(["--acp", "--stdio", "--model=claude-haiku-4.5", "--reasoning-effort=medium", "--max-ai-credits=5"]);
  });

  it("configures Codex web search with the supported top-level key", () => {
    const codex = new CodexSessionManager(() => undefined);
    expect(JSON.parse(codex["command"]({ webSearch: "disabled" }).env.CODEX_CONFIG as string)).toEqual({ web_search: "disabled" });
    expect(JSON.parse(codex["command"]({ webSearch: "default" }).env.CODEX_CONFIG as string)).toEqual({});
    expect(codex["command"]({ mode: "read-only" }).env.INITIAL_AGENT_MODE).toBe("read-only");
  });
  it("queues mid-turn input for agents without steering and runs it next", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-queue-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" } });
    const steered = await provider.steer(workspace, "second");
    expect(steered.steering).toBe(false);
    const session = await settle(provider, workspace);
    expect(session.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["first", "second"]);
    // Two full turns ran, so the scripted reply appears twice.
    expect(session.messages.filter((message) => message.text === "Hello, world")).toHaveLength(2);
    expect(session.status).toBe("done");
    await provider.clear(workspace);
  });

  it("injects mid-turn input into the live turn when the agent supports steering", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-steer-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_STEERING: "on", FAKE_SLOW: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" } });
    const steered = await provider.steer(workspace, "second");
    expect(steered.steering).toBe(true);
    await provider.interrupt(workspace);
    const session = await provider.get(workspace);
    expect(session.messages.some((message) => message.text.includes("[steered: second]"))).toBe(true);
    // A single turn absorbed the follow-up, so "working" was not restarted.
    expect(session.messages.filter((message) => message.text.startsWith("working"))).toHaveLength(1);
    await provider.clear(workspace);
  });

  it("stays interrupted even when the agent reports the cancelled turn as a success", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-interrupt-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" } });
    await provider.steer(workspace, "queued follow-up");
    const stopped = await provider.interrupt(workspace);
    expect(stopped.status).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const session = await provider.get(workspace);
    expect(session.status).toBe("idle");
    expect(session.messages.at(-1)?.text).toBe("Interrupted by user");
    expect(session.messages.some((message) => message.text.includes("trailing output after cancel"))).toBe(false);
    await expect(provider.steer(workspace, "too late")).rejects.toThrow("not currently working");
    await provider.clear(workspace);
  });

  it("rejects mid-turn input when nothing is running", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-idle-steer-"));
    const provider = new FakeProvider(() => undefined, state);
    await expect(provider.steer(process.cwd(), "hello")).rejects.toThrow("not currently working");
  });

  it("loads the persisted ACP session and replaces the local transcript with authoritative history", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-resume-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_LOAD: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" } });
    await settle(provider, workspace);
    // This fixture-only launch option closes the runtime; the next send must load
    // the stored session id instead of silently creating a fresh conversation.
    await provider.configure(workspace, { maxAiCredits: 1 });
    await provider.send(workspace, { prompt: "second", configuration: { model: "model-a", maxAiCredits: 1 } });
    const session = await settle(provider, workspace);
    expect(session.messages.some((message) => message.text === "Restored authoritative history")).toBe(true);
    expect(session.messages.some((message) => message.text === "first")).toBe(false);
    await provider.clear(workspace);
  });

  it("blocks permission requests until the user selects an advertised option", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-permission-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_PERMISSION: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "permission", configuration: { model: "model-a" } });
    let session = await provider.get(workspace);
    for (let attempt = 0; !session.pendingPermission && attempt < 100; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); session = await provider.get(workspace); }
    expect(session.pendingPermission).toMatchObject({ title: "Write protected file", details: "$ touch /protected" });
    await provider.resolvePermission(workspace, session.pendingPermission!.id, "yes");
    session = await settle(provider, workspace);
    expect(session.messages.some((message) => message.text.includes("Permission: yes"))).toBe(true);
    await provider.clear(workspace);
  });

  it("maps typed prompt blocks and remote MCP transports to ACP", async () => {
    const provider = new FakeProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-content-")));
    const blocks = provider["promptContent"](process.cwd(), "look", [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource", uri: "attachment:notes.txt", mimeType: "text/plain", text: "notes" },
      { type: "resource_link", uri: "workspace:README.md", name: "README.md" }
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "resource", "resource_link"]);
    expect(provider["mcpServers"]([{ transport: "http", name: "remote", url: "https://example.test/mcp", headers: { Authorization: "secret" } }])).toEqual([{ type: "http", name: "remote", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "secret" }] }]);
  });
});
