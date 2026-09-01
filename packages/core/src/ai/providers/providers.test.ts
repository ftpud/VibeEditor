import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
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

class MissingProvider extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = { id: "missing", name: "Missing ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [], capabilities: { models: true, usage: false, mcp: false, agents: false, contextWindow: false } };
  protected command() { return { command: path.join(os.tmpdir(), `missing-acp-${crypto.randomUUID()}`), args: [] }; }
  protected async fallbackModels(): Promise<AiModel[]> { return [{ id: "fallback", name: "Fallback", defaultReasoning: "", reasoningLevels: [] }]; }
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
  it("falls back without crashing when an optional provider executable is missing", async () => {
    const provider = new MissingProvider(() => undefined);
    await expect(provider.models()).resolves.toEqual([{ id: "fallback", name: "Fallback", defaultReasoning: "", reasoningLevels: [] }]);
  });

  it("keeps a session owned by another live process in progress but marks an abandoned session as error", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-owner-"));
    const workspace = process.cwd();
    const running = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    await running.send(workspace, { prompt: "slow work", configuration: { model: "model-a" } });

    const observer = new FakeProvider(() => undefined, state);
    expect((await observer.get(workspace)).status).toBe("in_progress");
    await running.interrupt(workspace);
    await settle(running, workspace);

    const abandonedWorkspace = "/workspace/abandoned";
    const hash = crypto.createHash("sha256").update(abandonedWorkspace).digest("hex");
    await writeFile(path.join(state, `${hash}-fake.json`), JSON.stringify({ status: "in_progress", model: "model-a", reasoning: "medium", messages: [], _ownerPid: 999_999_999 }));
    expect((await observer.get(abandonedWorkspace)).status).toBe("error");
  });

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
    expect(assistant.map((message) => ({ model: message.model, reasoning: message.reasoning }))).toEqual([{ model: "model-a", reasoning: "high" }, { model: "model-a", reasoning: "high" }]);
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

  it("consumes a queued model selection on exactly the next new turn", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-next-model-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    await provider.configureNext(workspace, { model: "model-a", reasoning: "high" });
    expect((await provider.get(workspace)).nextConfiguration).toEqual({ model: "model-a", reasoning: "high" });
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-b", reasoning: "" } });
    let session = await settle(provider, workspace);
    expect(session).toMatchObject({ model: "model-a", reasoning: "high" });
    expect(session.nextConfiguration).toBeUndefined();
    await provider.send(workspace, { prompt: "second", configuration: { model: "model-b", reasoning: "" } });
    session = await settle(provider, workspace);
    expect(session.model).toBe("model-b");
    expect(session.messages.filter((message) => message.role === "assistant").slice(0, 2).every((message) => message.model === "model-a")).toBe(true);
    expect(session.messages.filter((message) => message.role === "assistant").slice(-2).every((message) => message.model === "model-b")).toBe(true);
    await provider.clear(workspace);
  });

  it("forces a model-authored continuation into a new turn that consumes the queued model", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-model-continuation-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-b", reasoning: "" } });
    await provider.configureNext(workspace, { model: "model-a", reasoning: "high" });
    await provider.steer(workspace, "continue", { senderModel: "model-b", queue: true });
    const session = await settle(provider, workspace);
    expect(session).toMatchObject({ model: "model-a", reasoning: "high" });
    expect(session.messages.find((message) => message.text === "continue")).toMatchObject({ role: "user", senderModel: "model-b" });
    expect(session.messages.filter((message) => message.text.startsWith("working"))).toHaveLength(2);
    expect(session.messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({ model: "model-a", reasoning: "high" });
    await provider.clear(workspace);
  });

  it("archives conversations so they can be listed, switched back to and removed", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-sessions-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();

    expect((await provider.get(workspace)).id).toBe((await provider.get(workspace)).id);

    await provider.send(workspace, { prompt: "first conversation", configuration: { model: "model-a", reasoning: "low" } });
    const first = await settle(provider, workspace);
    const second = await provider.clear(workspace);
    expect(second.id).not.toBe(first.id);
    await provider.send(workspace, { prompt: "second conversation", configuration: { model: "model-a", reasoning: "low" } });
    await settle(provider, workspace);

    const listed = await provider.sessions(workspace);
    expect(listed.map((session) => session.id)).toEqual([second.id, first.id]);
    expect(listed[1]!.messages[0]?.text).toBe("first conversation");

    const restored = await provider.restore(workspace, first.id!);
    expect(restored.id).toBe(first.id);
    expect(restored.messages.map((message) => message.text)).toEqual(first.messages.map((message) => message.text));
    expect((await provider.get(workspace)).id).toBe(first.id);
    expect((await provider.sessions(workspace)).map((session) => session.id)).toEqual([first.id, second.id]);

    // A restarted backend has to rebuild the listing from disk before it can switch sessions.
    const restarted = new FakeProvider(() => undefined, state);
    expect((await restarted.sessions(workspace)).map((session) => session.id)).toEqual([first.id, second.id]);
    expect((await restarted.restore(workspace, second.id!)).messages.map((message) => message.text)).toContain("second conversation");
    await provider.restore(workspace, first.id!);

    await expect(provider.restore(workspace, "unknown-session")).rejects.toThrow(/no longer available/);

    const afterRemoval = await provider.remove(workspace, first.id!);
    expect(afterRemoval.id).toBe(second.id);
    expect(afterRemoval.messages[0]?.text).toBe("second conversation");
    expect((await provider.sessions(workspace)).map((session) => session.id)).toEqual([second.id]);

    const afterLastRemoval = await provider.remove(workspace, second.id!);
    expect(afterLastRemoval.messages).toEqual([]);
    expect((await provider.sessions(workspace)).map((session) => session.id)).toEqual([afterLastRemoval.id]);
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

  it("injects selected agent instructions once per provider session and again when they change", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-agent-preset-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on" });
    const workspace = process.cwd();
    const dispatcher = { name: "Dispatcher", description: "Coordinates work", instructions: "Delegate bounded tasks.", mcpServers: ["vibe-editor"] };

    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" }, agent: dispatcher });
    await settle(provider, workspace);
    await provider.send(workspace, { prompt: "second", configuration: { model: "model-a" }, agent: dispatcher });
    await settle(provider, workspace);
    await provider.send(workspace, { prompt: "third", configuration: { model: "model-a" }, agent: { ...dispatcher, instructions: "Coordinate without waiting." } });
    const session = await settle(provider, workspace);
    const prompts = session.messages.filter((message) => message.role === "assistant" && message.text.startsWith("PROMPT:"));

    expect(prompts).toHaveLength(3);
    expect(prompts[0]!.text).toContain("<agent_instructions>");
    expect(prompts[0]!.text).toContain("Delegate bounded tasks.");
    expect(prompts[1]!.text).not.toContain("<agent_instructions>");
    expect(prompts[1]!.text).toContain("second");
    expect(prompts[2]!.text).toContain("<agent_instructions>");
    expect(prompts[2]!.text).toContain("Coordinate without waiting.");
    expect(session.agent?.name).toBe("Dispatcher");
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

  it("archives a running conversation and starts a context-empty handoff session", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-fresh-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    const first = await provider.send(workspace, { prompt: "old context", configuration: { model: "model-a", reasoning: "high" } });
    await provider.startFreshSession(workspace, { prompt: "fresh handoff", configuration: first.configuration ?? { model: first.model, reasoning: first.reasoning } });
    let fresh = await provider.get(workspace);
    for (let attempt = 0; attempt < 240 && (fresh.id === first.id || fresh.status === "in_progress" || !fresh.messages.some((message) => message.text === "fresh handoff")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25)); fresh = await provider.get(workspace);
    }
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["fresh handoff"]);
    const archived = (await provider.sessions(workspace)).find((session) => session.id === first.id);
    expect(archived?.messages.some((message) => message.text === "old context")).toBe(true);
    await provider.clear(workspace);
  });

  it("carries the selected local agent preset into a queued fresh session", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-fresh-agent-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    const oleg = { name: "Oleg", instructions: "Implement repository features end to end." };
    const preset = { scope: "local" as const, name: "Oleg.md" };
    const first = await provider.send(workspace, { prompt: "old context", configuration: { model: "model-a" }, agent: oleg, agentPreset: preset });
    await provider.startFreshSession(workspace, { prompt: "fresh handoff", configuration: { model: "model-a" }, agent: oleg, agentPreset: preset });
    let fresh = await provider.get(workspace);
    for (let attempt = 0; attempt < 240 && (fresh.id === first.id || fresh.status === "in_progress" || !fresh.messages.some((message) => message.text === "fresh handoff")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25)); fresh = await provider.get(workspace);
    }
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.agentPreset).toEqual(preset);
    expect(fresh.agent?.name).toBe("Oleg");
    expect((await provider.sessions(workspace)).find((session) => session.id === first.id)?.messages.some((message) => message.text === "old context")).toBe(true);
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

  it("loads the persisted ACP session while keeping the local transcript in order", async () => {
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
    // The replayed history would land after the new prompt and push it to the top of the box, so
    // the transcript we already persisted is kept and the fresh prompt stays at the bottom.
    expect(session.messages.some((message) => message.text === "Restored authoritative history")).toBe(false);
    expect(session.messages.some((message) => message.text === "first")).toBe(true);
    expect(session.messages.findIndex((message) => message.text === "second")).toBeGreaterThan(session.messages.findIndex((message) => message.text === "first"));
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

  it("passes a selected agent and user request in the same ACP text block", async () => {
    const provider = new FakeProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-agent-")));
    const content = provider["withAgent"]([{ type: "text", text: "Fix the bug" }], { name: "Reviewer", description: "Checks correctness", instructions: "Review every change." });
    expect(content).toEqual([{ type: "text", text: "Selected agent: Reviewer\nAgent description: Checks correctness\n\n<agent_instructions>\nReview every change.\n</agent_instructions>\n\n<user_request>\nFix the bug\n</user_request>" }]);
  });
});
