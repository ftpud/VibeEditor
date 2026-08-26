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

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));

class FakeProvider extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = { id: "fake", name: "Fake ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true } };
  protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_AGENT] }; }
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

  it("reads the model catalogue and per-model reasoning levels from the live agent", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-models-"));
    const provider = new FakeProvider(() => undefined, state);
    expect(await provider.models()).toEqual([
      { id: "model-a", name: "MODEL-A", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"] },
      { id: "model-b", name: "MODEL-B", defaultReasoning: "", reasoningLevels: [] }
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

  it("never passes reasoning effort on the Copilot command line", () => {
    const command = new CopilotSessionManager(() => undefined)["command"]({ model: "claude-haiku-4.5", reasoning: "medium", maxAiCredits: 5 });
    expect(command.args).toEqual(["--acp", "--stdio", "--max-ai-credits=5"]);
  });

  it("configures Codex web search with the supported top-level key", () => {
    const codex = new CodexSessionManager(() => undefined);
    expect(JSON.parse(codex["command"]({ webSearch: "disabled" }).env.CODEX_CONFIG as string)).toEqual({ web_search: "disabled" });
    expect(JSON.parse(codex["command"]({ webSearch: "default" }).env.CODEX_CONFIG as string)).toEqual({});
    expect(codex["command"]({ mode: "read-only" }).env.INITIAL_AGENT_MODE).toBe("read-only");
  });
});
