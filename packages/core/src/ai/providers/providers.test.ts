import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiConfiguration, AiModel, AiProviderDescriptor, AiSession } from "@remote-ide/acp";
import { CodexSessionManager } from "./codex.js";
import { CopilotSessionManager } from "./copilot.js";
import { ClaudeSessionManager } from "./claude.js";
import { ASK_QUESTIONS_OPTION, LIVE_STEERING_OPTION, StdioAcpProvider, SYSTEM_INSTRUCTIONS_OPTION, type AcpTurnObserver } from "../stdio-provider.js";
import { SkillsStore } from "../../skills.js";
import { AcpRegistry } from "../acp.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.py", import.meta.url));
const FAKE_V2_AGENT = fileURLToPath(new URL("./fake-acp-agent-v2.mjs", import.meta.url));
const fakeProviders = new Set<StdioAcpProvider>();

class FakeProvider extends StdioAcpProvider {
  constructor(onChanged: (workspace: string) => void, state: string, private readonly env: NodeJS.ProcessEnv = {}, projectRoot?: (workspace: string) => Promise<string>, turns?: AcpTurnObserver) { super({ onChanged, stateDirectory: state, turns, projectRoot }); fakeProviders.add(this); }
  readonly descriptor: AiProviderDescriptor = { id: "fake", name: "Fake ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true, skills: true } };
  protected command(_configuration: AiConfiguration) { return { command: "python3", args: [FAKE_AGENT], env: this.env }; }
  protected async fallbackModels(): Promise<AiModel[]> { return [{ id: "fallback", name: "Fallback", defaultReasoning: "medium", reasoningLevels: ["medium"] }]; }
}

afterEach(async () => {
  const providers = [...fakeProviders];
  fakeProviders.clear();
  const results = await Promise.allSettled(providers.map((provider) => provider.shutdown()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
});

class MissingProvider extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = { id: "missing", name: "Missing ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [], capabilities: { models: true, usage: false, mcp: false, agents: false, contextWindow: false } };
  protected command() { return { command: path.join(os.tmpdir(), `missing-acp-${crypto.randomUUID()}`), args: [] }; }
  protected async fallbackModels(): Promise<AiModel[]> { return [{ id: "fallback", name: "Fallback", defaultReasoning: "", reasoningLevels: [] }]; }
}

const INSTALLED_ENTRY = path.join(os.tmpdir(), "provider-runtimes", "agent", "dist", "index.js");
/** Simulates the entry that `prepareLaunch` resolves from a managed installation. */
function installed<T extends StdioAcpProvider>(provider: T): T { return Object.assign(provider, { installedEntry: INSTALLED_ENTRY }); }

async function settle(provider: StdioAcpProvider, workspace: string, isSettled: (session: AiSession) => boolean = (session) => session.status !== "in_progress", timeoutMs = 5_000): Promise<AiSession> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await provider.get(workspace);
    if (isSettled(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the fake agent did not satisfy the completion condition within ${timeoutMs}ms`);
}

describe("ACP integration", () => {
  it("stops provider processes, flushes interrupted sessions and refuses new work during shutdown", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "acp-shutdown-"));
    const workspace = process.cwd();
    const turns = { begin: vi.fn(async () => "shutdown-checkpoint"), complete: vi.fn(async () => {}) };
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" }, undefined, turns);
    try {
      await provider.send(workspace, { prompt: "Work until stopped", configuration: { model: "model-a" } });
      expect((await provider.get(workspace)).status).toBe("in_progress");
      const stopped = provider.shutdown();
      expect(provider.shutdown()).toBe(stopped);
      await stopped;
      expect(turns.complete.mock.calls[0]?.slice(0, 3)).toEqual([workspace, expect.arrayContaining(["shutdown-checkpoint"]), "interrupted"]);
      const restored = await new FakeProvider(() => undefined, state).get(workspace);
      expect(restored.status).toBe("idle");
      expect(restored.messages.some((message) => message.text.includes("Core is shutting down"))).toBe(true);
      await expect(provider.send(workspace, { prompt: "Too late", configuration: { model: "model-a" } })).rejects.toThrow("shutting down");
    } finally { await provider.shutdown(); }
  });

  it("reuses persisted session labels after restart and rebuilds damaged or stale indexes", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "acp-summary-index-"));
    const workspace = "/workspace";
    const key = crypto.createHash("sha256").update(workspace).digest("hex");
    const directory = path.join(state, `${key}-fake-sessions`);
    const file = path.join(directory, "archived.json");
    await mkdir(directory);
    const archived: AiSession = { id: "archived", status: "idle", model: "auto", reasoning: "low", messages: [{ id: "first", role: "user", text: "Archived question", timestamp: "now" }, { id: "reply", role: "assistant", text: "x".repeat(200_000), timestamp: "now" }] };
    await writeFile(file, JSON.stringify(archived));
    const provider = new FakeProvider(() => {}, state);
    expect((await provider.sessions(workspace)).find((session) => session.id === "archived")?.messages).toHaveLength(1);
    const indexFile = `${directory}.index.json`;
    const cached = JSON.parse(await readFile(indexFile, "utf8"));
    expect(JSON.stringify(cached).length).toBeLessThan(1000);
    // A different label in the derived index proves the restarted provider
    // loaded it instead of rereading and summarizing the full transcript.
    cached.sessions[0].messages[0].text = "Cached label";
    await writeFile(indexFile, JSON.stringify(cached));
    expect((await new FakeProvider(() => {}, state).sessions(workspace)).find((session) => session.id === "archived")?.messages[0]?.text).toBe("Cached label");
    await writeFile(indexFile, "damaged index");
    expect((await new FakeProvider(() => {}, state).sessions(workspace)).find((session) => session.id === "archived")?.messages[0]?.text).toBe("Archived question");
    await writeFile(`${file}.tmp`, JSON.stringify({ ...archived, messages: [{ ...archived.messages[0], text: "Updated question" }] }));
    await rename(`${file}.tmp`, file);
    expect((await provider.sessions(workspace)).find((session) => session.id === "archived")?.messages[0]?.text).toBe("Updated question");
  });

  it("launches installed agents with Core's Node, honours Core-host overrides and refuses uninstalled providers", async () => {
    for (const name of ["CODEX_PATH", "CODEX_ACP_COMMAND", "CLAUDE_ACP_COMMAND", "CLAUDE_AGENT_ACP_PATH", "COPILOT_CLI_PATH"]) vi.stubEnv(name, undefined);
    vi.stubEnv("REMOTE_IDE_PROVIDER_RUNTIME_DIR", path.join(os.tmpdir(), `vibe-no-providers-${crypto.randomUUID()}`));
    class InspectCodex extends CodexSessionManager { launch(configuration: AiConfiguration) { return this.command(configuration); } prepare() { return this.prepareLaunch(); } }
    class InspectClaude extends ClaudeSessionManager { launch(configuration: AiConfiguration) { return this.command(configuration); } }
    class InspectCopilot extends CopilotSessionManager { launch(configuration: AiConfiguration) { return this.command(configuration); } }
    try {
      const codex = new InspectCodex({ onChanged: () => undefined });
      await expect(codex.prepare()).rejects.toThrow("Codex ACP is not installed");
      expect(() => codex.launch({})).toThrow("not installed");
      expect(await codex.installation()).toMatchObject({ provider: "codex", status: "not_installed", package: "@agentclientprotocol/codex-acp" });
      expect(installed(new InspectCodex({ onChanged: () => undefined })).launch({})).toMatchObject({ command: process.execPath, args: [INSTALLED_ENTRY] });
      expect(installed(new InspectCodex({ onChanged: () => undefined })).launch({}).env).not.toHaveProperty("CODEX_PATH");
      expect(installed(new InspectClaude({ onChanged: () => undefined })).launch({})).toEqual({ command: process.execPath, args: [INSTALLED_ENTRY] });
      expect(installed(new InspectCopilot({ onChanged: () => undefined })).launch({})).toEqual({ command: process.execPath, args: [INSTALLED_ENTRY, "--acp", "--stdio"] });
      vi.stubEnv("CODEX_ACP_COMMAND", "/server/codex-acp");
      vi.stubEnv("CLAUDE_ACP_COMMAND", "/server/claude-acp");
      vi.stubEnv("COPILOT_CLI_PATH", "/server/copilot");
      expect(new InspectCodex({ onChanged: () => undefined }).launch({})).toMatchObject({ command: "/server/codex-acp", env: { CODEX_PATH: "codex" } });
      expect(new InspectClaude({ onChanged: () => undefined }).launch({}).command).toBe("/server/claude-acp");
      expect(new InspectCopilot({ onChanged: () => undefined }).launch({}).command).toBe("/server/copilot");
      expect(await new InspectCodex({ onChanged: () => undefined }).installation()).toMatchObject({ status: "installed", source: "external", location: "/server/codex-acp" });
      expect(await new AcpRegistry().register(new InspectCodex({ onChanged: () => undefined })).available()).toHaveLength(1);
      vi.stubEnv("CODEX_ACP_COMMAND", undefined);
      expect(await new AcpRegistry().register(new InspectCodex({ onChanged: () => undefined })).available()).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("offers GPT-6 Sol even when an older Codex catalogue omits it and launches it explicitly", async () => {
    class InspectCodex extends CodexSessionManager {
      describeCatalogue(models: AiModel[]) { return this.describeModels(models); }
      launch(configuration: AiConfiguration) { return this.command(configuration); }
    }
    const provider = installed(new InspectCodex({ onChanged: () => undefined }));
    const models = await provider.describeCatalogue([{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", defaultReasoning: "low", reasoningLevels: ["low"] }]);
    expect(models.find((model) => model.id === "gpt-6-sol")).toMatchObject({ defaultReasoning: "medium", reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"] });
    expect(models.filter((model) => model.id === "gpt-6-sol")).toHaveLength(1);
    expect(JSON.parse(provider.launch({ model: "gpt-6-sol", reasoning: "high" }).env.CODEX_CONFIG!)).toMatchObject({ model: "gpt-6-sol", model_reasoning_effort: "high" });
  });

  it("falls back without crashing when an optional provider executable is missing", async () => {
    const provider = new MissingProvider({ onChanged: () => undefined });
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
    const codex = new CodexSessionManager({ onChanged: () => undefined, stateDirectory: state });
    const copilot = new CopilotSessionManager({ onChanged: () => undefined, stateDirectory: state });
    await codex.configure(workspace, "gpt-test", "high");
    await copilot.configure(workspace, "claude-test", "low");
    expect(await codex.get(workspace)).toMatchObject({ model: "gpt-test", reasoning: "high" });
    expect(await copilot.get(workspace)).toMatchObject({ model: "claude-test", reasoning: "low" });
    expect(await copilot.get("/workspace/two")).toMatchObject({ model: "auto", reasoning: "medium" });
  });

  it("serializes concurrent ACP session saves", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-concurrent-"));
    const provider = new CodexSessionManager({ onChanged: () => undefined, stateDirectory: state });
    await Promise.all(Array.from({ length: 20 }, (_, index) => provider.configure("/workspace/concurrent", { model: `model-${index}`, reasoning: "medium" })));
    expect((await provider.get("/workspace/concurrent")).model).toMatch(/^model-\d+$/);
  });

  it("discovers providers through the ACP registry and rejects unknown plugins", () => {
    const registry = new AcpRegistry().register(new CodexSessionManager({ onChanged: () => undefined }));
    expect(registry.list().map((provider) => provider.id)).toEqual(["codex"]);
    expect(() => registry.get("missing")).toThrow("Unknown AI provider");
  });

  it("runs a whole turn over the experimental ACP v2 protocol and rejects agents that only speak v1", async () => {
    class FakeV2Provider extends FakeProvider {
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: this.v2Env }; }
      protected async protocol() { return "v2" as const; }
      constructor(state: string, private readonly v2Env: NodeJS.ProcessEnv = { FAKE_V2_REQUIRE_MCP: "1" }) { super(() => undefined, state); }
    }
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-v2-"));
    const workspace = process.cwd();
    const provider = new FakeV2Provider(state);
    // Vibe always passes its own stdio tool servers; v2 agents reject them unless typed.
    await provider.send(workspace, { prompt: "ping", configuration: { model: "model-b" }, mcpServers: [{ name: "vibe-tools", command: process.execPath, args: ["-e", "0"] }] });
    const session = await settle(provider, workspace);
    expect(session.failure).toBeUndefined();
    expect(session.status).toBe("done");
    // The whole-message upsert extends the streamed "Hello" chunk; the prompt arrives after Vibe's skill catalogue.
    const assistant = session.messages.filter((message) => message.role === "assistant").map((message) => message.text).join("");
    expect(assistant).toMatch(/^Hello from v2: [\s\S]*ping$/);
    expect(session.messages.find((message) => message.id === "tool-1")?.text).toContain("Run echo");
    expect(session.tokens).toMatchObject({ total: 30, input: 10, output: 20 });
    await provider.shutdown();
    const v1Only = new FakeV2Provider(await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-v2-only-v1-")), { FAKE_V2_ONLY_V1: "1" });
    await expect(v1Only.send(workspace, { prompt: "ping", configuration: {} })).rejects.toThrow("does not support ACP v2");
  });

  it("shows and tracks a turn an ACP v2 agent starts on its own after going idle", async () => {
    class AgentTurnV2Provider extends FakeProvider {
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_V2_AGENT_TURN: "1" } }; }
      protected async protocol() { return "v2" as const; }
    }
    const provider = new AgentTurnV2Provider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-v2-agent-turn-")));
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "start a build", configuration: {} });
    await until(provider, workspace, (session) => session.status === "done");
    const resumed = await until(provider, workspace, (session) => session.messages.some((message) => message.text === "Background build finished"));
    expect(resumed.messages.some((message) => message.role === "activity" && message.text.includes("resumed work on its own"))).toBe(true);
    const session = await until(provider, workspace, (current) => current.status === "done" && current.messages.some((message) => message.text === "Background build finished"));
    expect(session.failure).toBeUndefined();
    await provider.send(workspace, { prompt: "next", configuration: {} });
    expect((await settle(provider, workspace)).status).toBe("done");
    await provider.shutdown();
  });

  it("keeps showing a prompt an ACP v2 agent queued behind the turn it was steered into", async () => {
    class QueueingV2Provider extends FakeProvider {
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_V2_STEERING: "queue" } }; }
      protected async protocol() { return "v2" as const; }
    }
    const provider = new QueueingV2Provider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-v2-queued-steer-")));
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: {} });
    await provider.steer(workspace, "hi");
    const answered = await until(provider, workspace, (session) => session.messages.some((message) => message.text.includes("Answering queued: hi")));
    expect(answered.messages.some((message) => message.text.includes("Queued work"))).toBe(true);
    const done = await until(provider, workspace, (session) => session.status === "done" && session.messages.some((message) => message.text.includes("Answering queued: hi")));
    expect(done.failure).toBeUndefined();
    await provider.shutdown();
  });

  it("does not replay configuration notifications after an ACP v2 reasoning rejection", async () => {
    class FeedbackV2Provider extends FakeProvider {
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_CONFIG_FEEDBACK: "on" } }; }
      protected async protocol() { return "v2" as const; }
    }
    const provider = new FeedbackV2Provider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-v2-config-feedback-")));
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: { model: "model-b", reasoning: "high" } });
    const session = await settle(provider, workspace);
    expect(session).toMatchObject({ status: "done", model: "model-b", reasoning: "medium" });
    expect(session.messages.filter((message) => message.text.startsWith("Session configuration"))).toHaveLength(1);
    expect(session.messages.some((message) => message.text.includes("Invalid reasoning parameter"))).toBe(true);
    expect(session.messages.some((message) => message.text === "Configuration writes: 2")).toBe(true);
    await provider.send(workspace, { prompt: "continue", configuration: {} });
    const continued = await settle(provider, workspace);
    expect(continued.messages.filter((message) => message.text.startsWith("Session configuration"))).toHaveLength(1);
    expect(continued.messages.filter((message) => message.text === "Configuration writes: 2")).toHaveLength(2);
  });

  it.each(["on", "prompt"])("steers an active ACP v2 turn using the advertised extension or prompt fallback: %s", async (steering) => {
    class SteeringV2Provider extends FakeProvider {
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_V2_STEERING: steering } }; }
      protected async protocol() { return "v2" as const; }
    }
    const workspace = process.cwd();
    const provider = new SteeringV2Provider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-v2-steer-")));
    await provider.send(workspace, { prompt: "first", configuration: {} });
    const working = await until(provider, workspace, (session) => session.messages.some((message) => message.text.includes("Hello from v2:")));
    expect(working.steering).toBe(true);
    expect(working.status).toBe("in_progress");
    await provider.steer(workspace, "second");
    const session = await settle(provider, workspace);
    expect(session.failure).toBeUndefined();
    expect(session.status).toBe("done");
    expect(session.messages.some((message) => message.text.includes("[steered: second]"))).toBe(true);
    expect(session.messages.some((message) => message.text.includes("Steering message failed"))).toBe(false);
    expect(session.messages.filter((message) => message.text.includes("Hello from v2:"))).toHaveLength(1);
  });

  it.each([
    { stage: "prompt", failures: "2", output: "", expected: "done" },
    { stage: "new", failures: "2", output: "", expected: "done" },
    { stage: "prompt", failures: "99", output: "", expected: "error" },
    { stage: "prompt", failures: "1", output: "on", expected: "error" }
  ])("retries OAuth contention with clean errors and no work replay: $stage/$failures/$output", async ({ stage, failures, output, expected }) => {
    class OAuthProvider extends FakeProvider {
      protected readonly oauthRefreshRetryDelays = [1, 1];
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_OAUTH_STAGE: stage, FAKE_OAUTH_FAILURES: failures, FAKE_OAUTH_OUTPUT: output } }; }
      protected async protocol() { return "v2" as const; }
    }
    const provider = new OAuthProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "acp-oauth-")));
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: {} });
    const session = await settle(provider, workspace);
    expect(session.status).toBe(expected);
    const retries = session.messages.filter((message) => message.text.startsWith("OAuth token refresh is busy"));
    if (stage === "prompt" && output !== "on") expect(retries).toHaveLength(2);
    if (expected === "error") {
      const message = session.messages.filter((item) => item.role === "error").at(-1)?.text;
      expect(message).toContain("Failed to refresh OAuth token");
      expect(message).not.toMatch(/\[session\/create\]|\[session\/query\]|\[authStatus\]/);
    } else expect(session.failure).toBeUndefined();
    if (output === "on") expect(session.messages.filter((message) => message.text === "Work already started")).toHaveLength(1);
  });

  it("cancels a pending OAuth retry when the user interrupts", async () => {
    class OAuthProvider extends FakeProvider {
      protected readonly oauthRefreshRetryDelays = [60000];
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: { FAKE_OAUTH_STAGE: "prompt", FAKE_OAUTH_FAILURES: "99" } }; }
      protected async protocol() { return "v2" as const; }
    }
    const provider = new OAuthProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "acp-oauth-cancel-")));
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: {} });
    await until(provider, workspace, (session) => session.messages.some((message) => message.text.startsWith("OAuth token refresh is busy")));
    await provider.interrupt(workspace);
    await provider.shutdown();
    const session = await provider.get(workspace);
    expect(session.status).toBe("idle");
    expect(session.messages.filter((message) => message.role === "error")).toHaveLength(0);
  });

  it("withholds credential variables from the agent when the provider uses its own sign-in", async () => {
    class CredentialProvider extends FakeProvider {
      withheld: string[] = [];
      protected command(_configuration: AiConfiguration) { return { command: process.execPath, args: [FAKE_V2_AGENT], env: {} }; }
      protected async protocol() { return "v2" as const; }
      protected async withheldEnv() { return this.withheld; }
    }
    vi.stubEnv("FAKE_SECRET", "sk-test");
    try {
      const workspace = process.cwd();
      const inherits = new CredentialProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-credentials-")));
      await inherits.send(workspace, { prompt: "ping", configuration: {} });
      expect((await settle(inherits, workspace)).messages.map((message) => message.text).join("")).toContain("(secret visible)");
      await inherits.shutdown();
      const login = new CredentialProvider(() => undefined, await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-credentials-login-")));
      login.withheld = ["FAKE_SECRET"];
      await login.send(workspace, { prompt: "ping", configuration: {} });
      const session = await settle(login, workspace);
      expect(session.status).toBe("done");
      expect(session.messages.map((message) => message.text).join("")).not.toContain("(secret visible)");
    } finally { vi.unstubAllEnvs(); }
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
    expect(session.context?.history.at(-1)).toMatchObject({ used: 120, limit: 1000 });
    expect(session.context?.sections.find((section) => section.id === "tools")?.entries[0]?.preview).toBe("Run echo\n$ echo hi\nhi");
    expect(session.context?.sections.find((section) => section.id === "reasoning")?.characters).toBeGreaterThan(0);
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

  it("uses an explicitly selected model instead of a stale queued model on the first prompt", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-explicit-model-"));
    const provider = new FakeProvider(() => undefined, state);
    const workspace = process.cwd();
    await provider.configureNext(workspace, { model: "model-a", reasoning: "high" });
    await provider.configure(workspace, { model: "model-b", reasoning: "" });

    expect((await provider.get(workspace)).nextConfiguration).toBeUndefined();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-b", reasoning: "" } });

    const session = await settle(provider, workspace);
    expect(session.model).toBe("model-b");
    expect(session.messages.filter((message) => message.role === "assistant").every((message) => message.model === "model-b")).toBe(true);
    await provider.clear(workspace);
  });

  it("forces a model-authored continuation into a new turn that consumes the queued model", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-model-continuation-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-b", reasoning: "" } });
    await provider.steer(workspace, "continue", { senderModel: "model-b", queue: true });
    await provider.configureNext(workspace, { model: "model-a", reasoning: "high" });
    const session = await settle(provider, workspace, (current) => current.status === "done"
      && current.model === "model-a"
      && current.messages.filter((message) => message.text.startsWith("working")).length === 2, 15_000);
    expect(session).toMatchObject({ model: "model-a", reasoning: "high" });
    expect(session.messages.find((message) => message.text === "continue")).toMatchObject({ role: "user", senderModel: "model-b" });
    expect(session.messages.filter((message) => message.text.startsWith("working"))).toHaveLength(2);
    expect(session.messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({ model: "model-a", reasoning: "high" });
    await provider.clear(workspace);
  }, 20_000);

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

  it("keeps an accepted model when the agent acknowledges configuration without returning options", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-config-ack-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_CONFIG_ACK_ONLY: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "hello", configuration: { model: "model-b", reasoning: "" } });
    const session = await settle(provider, workspace);
    expect(session.model).toBe("model-b");
    const fresh = await provider.clear(workspace);
    expect(fresh.model).toBe("model-b");
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
    const instructions = session.context?.sections.find((section) => section.id === "instructions");
    expect(instructions?.entries.filter((item) => item.label === "Agent: Dispatcher").map((item) => item.preview)).toEqual(["Delegate bounded tasks.", "Coordinate without waiting."]);
    await provider.clear(workspace);
  });

  it("passes server-scoped Copilot model and reasoning configuration at launch", () => {
    const command = installed(new CopilotSessionManager({ onChanged: () => undefined }))["command"]({ model: "claude-haiku-4.5", reasoning: "medium", maxAiCredits: 5 });
    expect(command.args).toEqual([INSTALLED_ENTRY, "--acp", "--stdio", "--model=claude-haiku-4.5", "--reasoning-effort=medium", "--max-ai-credits=5"]);
  });

  it("launches the installed Claude ACP adapter with session-scoped permission modes", () => {
    const claude = installed(new ClaudeSessionManager({ onChanged: () => undefined }));
    const command = claude["command"]({ mode: "plan" });
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe(INSTALLED_ENTRY);
    expect(claude.descriptor.options.find((option) => option.id === "mode")?.choices?.map((choice) => choice.value)).toContain("plan");
  });

  it("configures Codex web search with the supported top-level key", () => {
    const codex = installed(new CodexSessionManager({ onChanged: () => undefined }));
    expect(JSON.parse(codex["command"]({ webSearch: "disabled" }).env.CODEX_CONFIG as string)).toEqual({ web_search: "disabled" });
    expect(JSON.parse(codex["command"]({ webSearch: "default" }).env.CODEX_CONFIG as string)).toEqual({});
    expect(codex["command"]({ mode: "read-only" }).env.INITIAL_AGENT_MODE).toBe("read-only");
  });
  it.each([false, true])("skips helper snapshots for sends and steering (live steering: %s) and preserves regular checkpoints", async (liveSteering) => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-snapshots-"));
    const releaseFile = path.join(state, "release-prompt");
    const turns = { begin: vi.fn(async () => crypto.randomUUID()), complete: vi.fn(async () => {}) };
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on", FAKE_PROMPT_RELEASE_FILE: releaseFile, ...(liveSteering ? { FAKE_STEERING: "on" } : {}) }, undefined, turns);
    const workspace = process.cwd();
    const completedTurns = (count: number) => (session: AiSession) => session.status === "done"
      && session.messages.filter((message) => message.text.startsWith("working")).length === count;

    await provider.startFreshSession(workspace, { prompt: "helper assignment", configuration: { model: "model-a" }, captureSnapshots: false });
    await vi.waitFor(async () => expect((await provider.get(workspace)).messages.some((message) => message.text.startsWith("working"))).toBe(true), { timeout: 5_000 });
    await provider.steer(workspace, "helper steering");
    await writeFile(releaseFile, "release");
    const helperTurns = liveSteering ? 1 : 2;
    const helper = await settle(provider, workspace, completedTurns(helperTurns), 15_000);
    expect(helper.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["helper assignment", "helper steering"]);
    await provider.send(workspace, { prompt: "helper follow-up", configuration: {} });
    await settle(provider, workspace, completedTurns(helperTurns + 1), 15_000);
    expect(turns.begin).not.toHaveBeenCalled();
    expect(turns.complete).not.toHaveBeenCalled();

    await rm(releaseFile);
    await provider.startFreshSession(workspace, { prompt: "regular prompt", configuration: { model: "model-a" } });
    await vi.waitFor(async () => {
      const current = await provider.get(workspace);
      expect(current.id).not.toBe(helper.id);
      expect(current.messages.some((message) => message.text.startsWith("working"))).toBe(true);
    }, { timeout: 5_000 });
    await provider.steer(workspace, "regular steering");
    await writeFile(releaseFile, "release");
    await settle(provider, workspace, completedTurns(liveSteering ? 1 : 2), 15_000);
    expect(turns.begin).toHaveBeenCalledTimes(2);
    expect(turns.complete).toHaveBeenCalled();
    expect(turns.complete.mock.calls.flat()).toContain("completed");
  }, 20_000);

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
    const fresh = await settle(provider, workspace, (session) => session.id !== first.id
      && session.status === "done"
      && session.messages.some((message) => message.role === "user" && message.text === "fresh handoff"), 15_000);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["fresh handoff"]);
    const archived = (await provider.sessions(workspace)).find((session) => session.id === first.id);
    expect(archived?.messages.some((message) => message.text === "old context")).toBe(true);
    await provider.clear(workspace);
  }, 20_000);

  it("carries the selected local agent preset into a queued fresh session", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-fresh-agent-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_SLOW: "on" });
    const workspace = process.cwd();
    const oleg = { name: "Oleg", instructions: "Implement repository features end to end." };
    const preset = { scope: "local" as const, name: "Oleg.md" };
    const first = await provider.send(workspace, { prompt: "old context", configuration: { model: "model-a" }, agent: oleg, agentPreset: preset });
    await provider.startFreshSession(workspace, { prompt: "fresh handoff", configuration: { model: "model-a" }, agent: oleg, agentPreset: preset });
    const fresh = await settle(provider, workspace, (session) => session.id !== first.id
      && session.status === "done"
      && session.messages.some((message) => message.role === "user" && message.text === "fresh handoff"), 15_000);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.agentPreset).toEqual(preset);
    expect(fresh.agent?.name).toBe("Oleg");
    expect((await provider.sessions(workspace)).find((session) => session.id === first.id)?.messages.some((message) => message.text === "old context")).toBe(true);
    await provider.clear(workspace);
  }, 20_000);

  it("injects mid-turn input into the live turn when the agent supports steering", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-ai-steer-"));
    const provider = new FakeProvider(() => undefined, state, { FAKE_STEERING: "on", FAKE_SLOW: "on" });
    const workspace = process.cwd();
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" } });
    const steered = await provider.steer(workspace, "second");
    expect(steered.steering).toBe(true);
    // Steering acknowledgement does not wait for the asynchronous transcript
    // notification. Observe it before cancellation intentionally drops late output.
    await vi.waitFor(async () => expect((await provider.get(workspace)).messages.some((message) => message.text.includes("[steered: second]"))).toBe(true), { timeout: 4_000 });
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

  it("supports Copilot Autopilot for new turns and a pending permission without restarting", async () => {
    class FakeCopilot extends CopilotSessionManager {
      constructor(onChanged: (workspace: string) => void, state: string) { super({ onChanged, stateDirectory: state }); fakeProviders.add(this); }
      protected async prepareLaunch() {}
      protected command() { return { command: "python3", args: [FAKE_AGENT], env: { FAKE_PERMISSION: "on" } }; }
    }
    const state = await mkdtemp(path.join(os.tmpdir(), "copilot-autopilot-"));
    const workspace = process.cwd();
    const provider = new FakeCopilot(() => {}, state);
    await provider.send(workspace, { prompt: "unattended", configuration: { model: "model-a", autopilot: true } });
    let session = await settle(provider, workspace);
    expect(session.pendingPermission).toBeUndefined();
    expect(session.messages.some((message) => message.text.includes("Permission: yes"))).toBe(true);
    expect(session.availableOptions).toContainEqual(expect.objectContaining({ id: "autopilot", permissionApproval: true }));
    await provider.configure(workspace, { autopilot: false });
    await provider.send(workspace, { prompt: "ask me", configuration: {} });
    for (let attempt = 0; !session.pendingPermission && attempt < 100; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); session = await provider.get(workspace); }
    expect(session.pendingPermission).toBeDefined();
    const threadId = session.threadId;
    const sessionId = session.id;
    const pendingId = session.pendingPermission!.id;
    await expect(provider.configure(workspace, { model: "model-b" })).rejects.toThrow("currently working");
    await provider.configure(workspace, { autopilot: true });
    session = await settle(provider, workspace);
    expect(session).toMatchObject({ id: sessionId, threadId, configuration: { autopilot: true } });
    expect(session.pendingPermission).toBeUndefined();
    expect(session.messages.filter((message) => message.text.includes("Permission: yes"))).toHaveLength(2);
    await expect(provider.resolvePermission(workspace, pendingId, "yes")).rejects.toThrow("no longer pending");
    await provider.configure(workspace, { autopilot: false });
    await provider.send(workspace, { prompt: "ask again", configuration: {} });
    session = await provider.get(workspace);
    for (let attempt = 0; !session.pendingPermission && attempt < 100; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); session = await provider.get(workspace); }
    expect(session.pendingPermission).toBeDefined();
    await provider.resolvePermission(workspace, session.pendingPermission!.id, "no");
    await settle(provider, workspace);
  }, 15_000);

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


describe("chat skills", () => {
  it("delivers root-project local skills in every task workspace", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "skills-shared-state-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "skills-shared-project-"));
    const task = await mkdtemp(path.join(os.tmpdir(), "skills-shared-task-"));
    const skills = new SkillsStore(state, root);
    await skills.write("local/shared", root, "Project-wide review workflow.");
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on" }, async () => root);
    await provider.send(task, { prompt: "Review this task", skillIds: ["local/shared"], configuration: { model: "model-a" } });
    const done = await settle(provider, task);
    expect(done.skillIds).toEqual(["local/shared"]);
    expect(done.messages.find((message) => message.text.startsWith("PROMPT:"))!.text).toContain("local/shared");
    expect(done.messages.find((message) => message.text.startsWith("PROMPT:"))!.text).not.toContain("Project-wide review workflow.");
    expect(await skills.load(task, "local/shared", done)).toMatchObject({ content: "Project-wide review workflow." });
    await provider.clear(task);
  });

  it("persists per-chat selection across restarts and restore, while new chats use project defaults", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "skills-provider-state-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "skills-provider-workspace-"));
    const skills = new SkillsStore(state);
    await skills.write("local/review", workspace, "Inspect regressions.");
    await skills.write("global/style", workspace, "Follow the style guide.");
    await skills.writePolicy(workspace, { allowed: ["local/review", "global/style"], defaults: ["local/review"] });
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on" });
    const first = await provider.get(workspace);
    expect(first.skillIds).toEqual(["local/review"]);
    await provider.setSkills(workspace, ["global/style"], first.id);
    const restarted = new FakeProvider(() => undefined, state);
    expect((await restarted.get(workspace)).skillIds).toEqual(["global/style"]);
    await provider.send(workspace, { prompt: "First turn", configuration: { model: "model-a" } });
    const done = await settle(provider, workspace);
    const echo = done.messages.find((message) => message.text.startsWith("PROMPT:"))!.text;
    expect(echo).toContain("global/style");
    expect(echo).not.toContain("Follow the style guide.");
    expect(echo).not.toContain("Inspect regressions.");
    expect(done.messages.find((message) => message.role === "user")!.text).toBe("First turn");
    await provider.clear(workspace);
    expect((await provider.get(workspace)).skillIds).toEqual(["local/review"]);
    await expect(provider.setSkills(workspace, [], first.id)).rejects.toThrow("different conversation");
    expect((await provider.restore(workspace, first.id!)).skillIds).toEqual(["global/style"]);
    await provider.clear(workspace);
  });

  it("delivers only skills assigned to the effective agent and supports a chat with no agent", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "skills-agent-state-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "skills-agent-workspace-"));
    const skills = new SkillsStore(state);
    const preset = { scope: "workspace" as const, name: "reviewer.md" };
    await skills.write("local/review", workspace, "Reviewer-only instructions");
    await skills.write("local/general", workspace, "No-agent instructions");
    await skills.writePolicy(workspace, { allowed: ["local/review", "local/general"], defaults: ["local/review", "local/general"], agents: { "local/review": [preset], "local/general": [null] } });
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on" });
    const session = await provider.get(workspace);
    await expect(provider.setSkills(workspace, ["local/review"], session.id, null)).rejects.toThrow("selected agent");
    await provider.send(workspace, { prompt: "Review", configuration: { model: "model-a" }, agent: { name: "Reviewer", instructions: "Review changes" }, agentPreset: preset });
    const reviewed = await settle(provider, workspace);
    const reviewEcho = reviewed.messages.find((message) => message.text.startsWith("PROMPT:"))!.text;
    expect(reviewEcho).toContain("local/review");
    expect(reviewEcho).not.toContain("Reviewer-only instructions");
    expect(reviewEcho).not.toContain("No-agent instructions");
    await provider.send(workspace, { prompt: "General", configuration: { model: "model-a" } });
    const general = await settle(provider, workspace);
    const generalEcho = general.messages.filter((message) => message.text.startsWith("PROMPT:")).at(-1)!.text;
    expect(generalEcho).toContain("local/general");
    expect(generalEcho).not.toContain("No-agent instructions");
    expect(generalEcho).not.toContain("Reviewer-only instructions");
    await provider.clear(workspace);
  });

  it("sends a catalogue once and only changed entries afterwards, including resumed and new threads", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "skills-delta-state-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "skills-delta-workspace-"));
    const skills = new SkillsStore(state);
    await skills.write("local/review", workspace, "---\nname: Reviewer\ndescription: Review changes\n---\n\nSecret long workflow");
    await skills.write("local/testing", workspace, "Test workflow body");
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on", FAKE_LOAD: "on" });
    const initial = await provider.get(workspace);
    await provider.setSkills(workspace, ["local/review"], initial.id);
    const send = async (prompt: string) => { await provider.send(workspace, { prompt, configuration: { model: "model-a" } }); const session = await settle(provider, workspace); return JSON.parse(session.messages.filter((message) => message.text.startsWith("PROMPT:")).at(-1)!.text.slice(7)).map((block: { text?: string }) => block.text ?? "").join("\n") as string; };
    const first = await send("First");
    expect(first).toContain("Vibe skill catalogue:"); expect(first).toContain("Review changes"); expect(first).not.toContain("Secret long workflow");
    expect(await send("Unchanged")).toBe("Unchanged");
    await provider.configure(workspace, { maxAiCredits: 1 });
    expect(await send("Resumed")).toBe("Resumed");
    await skills.write("local/review", workspace, "---\nname: Reviewer\ndescription: Better review\n---\n\nUpdated secret workflow");
    const edited = await send("Edited");
    expect(edited).toContain('"updated":[{"id":"local/review"'); expect(edited).toContain("Better review"); expect(edited).not.toContain("Updated secret workflow");
    await skills.write("local/review", workspace, "---\nname: Reviewer\ndescription: Better review\n---\n\nChanged body only");
    const bodyEdited = await send("Body edited"); expect(bodyEdited).toContain('"updated":[{"id":"local/review"'); expect(bodyEdited).not.toContain("Changed body only");
    await provider.setSkills(workspace, ["local/review", "local/testing"], initial.id);
    const added = await send("Added");
    expect(added).toContain('"added":[{"id":"local/testing"'); expect(added).not.toContain('"id":"local/review"');
    await provider.setSkills(workspace, ["local/testing"], initial.id);
    const removed = await send("Removed"); expect(removed).toContain('"removed":["local/review"]'); expect(removed).not.toContain('"id":"local/testing"');
    await skills.writePolicy(workspace, { allowed: [], defaults: [] });
    expect(await send("Revoked")).toContain('"removed":["local/testing"]');
    expect(await send("Still unchanged")).toBe("Still unchanged");
    await provider.clear(workspace);
    expect(await send("Fresh")).toContain("Vibe skill catalogue:");
    await provider.clear(workspace);
  });

  it("applies mid-turn changes only to a queued follow-up and honors project revocation", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "skills-queue-state-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "skills-queue-workspace-"));
    const skills = new SkillsStore(state);
    await skills.write("local/review", workspace, "Inspect regressions.");
    const provider = new FakeProvider(() => undefined, state, { FAKE_ECHO_PROMPT: "on", FAKE_SLOW: "on" });
    const first = await provider.get(workspace);
    await provider.setSkills(workspace, ["local/review"], first.id);
    await provider.send(workspace, { prompt: "First turn", configuration: { model: "model-a" } });
    await provider.setSkills(workspace, [], first.id);
    await provider.steer(workspace, "Follow-up", { queue: true });
    const done = await settle(provider, workspace, (session) => session.status === "done"
      && session.messages.filter((message) => message.text.startsWith("PROMPT:")).length === 2, 15_000);
    const echoes = done.messages.filter((message) => message.text.startsWith("PROMPT:"));
    expect(echoes).toHaveLength(2);
    expect(echoes[0]!.text).toContain("local/review");
    expect(echoes[0]!.text).not.toContain("Inspect regressions.");
    expect(echoes[1]!.text).not.toContain("Inspect regressions.");
    expect(echoes[1]!.text).toContain("removed");
    expect(echoes[1]!.text).toContain("local/review");
    await provider.setSkills(workspace, ["local/review"], first.id);
    await skills.writePolicy(workspace, { allowed: [], defaults: [] });
    await provider.send(workspace, { prompt: "After revocation", configuration: { model: "model-a" } });
    const revoked = await settle(provider, workspace, (session) => session.status === "done"
      && session.messages.filter((message) => message.text.startsWith("PROMPT:")).length >= 3, 15_000);
    expect(revoked.messages.filter((message) => message.text.startsWith("PROMPT:")).at(-1)!.text).not.toContain("Inspect regressions.");
    await provider.clear(workspace);
  }, 20_000);
});

class FeatureProvider extends FakeProvider {
  readonly descriptor: AiProviderDescriptor = { id: "feature", name: "Feature ACP", description: "test", settings: { title: "t", description: "d", sections: [] }, options: [ASK_QUESTIONS_OPTION, LIVE_STEERING_OPTION, SYSTEM_INSTRUCTIONS_OPTION], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true, skills: false } };
  protected sessionInstructionsMeta(instructions: string) { return { systemPrompt: { append: instructions } }; }
}

async function until(provider: StdioAcpProvider, workspace: string, condition: (session: AiSession) => boolean): Promise<AiSession> {
  return settle(provider, workspace, condition);
}

describe("ACP session features", () => {
  it("keeps agent questions off by default and asks through a form once enabled", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "acp-questions-"));
    const workspace = process.cwd();
    const provider = new FeatureProvider(() => undefined, state, { FAKE_QUESTION: "on" });
    await provider.send(workspace, { prompt: "pick", configuration: { model: "model-a" } });
    let session = await settle(provider, workspace);
    expect(session.messages.some((message) => message.text.includes("Questions unavailable"))).toBe(true);
    expect(session.pendingQuestion).toBeUndefined();

    await provider.configure(workspace, { askQuestions: true });
    await provider.send(workspace, { prompt: "pick again", configuration: {} });
    session = await until(provider, workspace, (item) => item.pendingQuestion !== undefined);
    const question = session.pendingQuestion!;
    expect(question.message).toBe("Which database?");
    expect(question.fields).toEqual([
      { id: "question_0", type: "choice", title: "Database", required: true, choices: [{ value: "pg", label: "Postgres", description: "Relational" }, { value: "redis", label: "Redis" }] },
      { id: "question_0_custom", type: "text", title: "Other" },
      { id: "extras", type: "multi", choices: [{ value: "cache", label: "Cache" }, { value: "queue", label: "Queue" }] },
      { id: "confirm", type: "boolean", title: "Confirm", defaultValue: true }
    ]);
    await expect(provider.answerQuestion(workspace, question.id, "accept", {})).rejects.toThrow("Database is required");
    await expect(provider.answerQuestion(workspace, question.id, "accept", { question_0: "mysql" })).rejects.toThrow("Invalid answer");
    await provider.answerQuestion(workspace, question.id, "accept", { question_0: "pg", extras: ["cache"], confirm: false, question_0_custom: "" });
    session = await settle(provider, workspace);
    expect(session.pendingQuestion).toBeUndefined();
    expect(session.messages.some((message) => message.text.includes('Answer: {"action":"accept","content":{"confirm":false,"extras":["cache"],"question_0":"pg"}}'))).toBe(true);
    await provider.clear(workspace);
  });

  it("steers agents that queue prompts into the running turn unless live steering is off", async () => {
    for (const liveSteering of [true, false]) {
      const state = await mkdtemp(path.join(os.tmpdir(), "acp-queueing-"));
      const releaseFile = path.join(state, "release");
      const workspace = process.cwd();
      const provider = new FeatureProvider(() => undefined, state, { FAKE_QUEUEING: "on", FAKE_SLOW: "on", FAKE_PROMPT_RELEASE_FILE: releaseFile });
      await provider.send(workspace, { prompt: "start", configuration: { model: "model-a", liveSteering } });
      let session = await until(provider, workspace, (item) => item.messages.some((message) => message.text === "working"));
      expect(session.steering).toBe(liveSteering);
      await provider.steer(workspace, "also this");
      if (liveSteering) await until(provider, workspace, (item) => item.messages.some((message) => message.text.includes("[queued: also this]")));
      expect((await provider.get(workspace)).status).toBe("in_progress");
      await writeFile(releaseFile, "");
      session = await settle(provider, workspace, (item) => item.status === "done");
      expect(session.messages.filter((message) => message.text.includes("[queued: also this]"))).toHaveLength(liveSteering ? 1 : 0);
      // Without live steering the message runs as the next turn after the first one settles.
      expect(session.messages.filter((message) => message.text === "working")).toHaveLength(liveSteering ? 1 : 2);
      await provider.clear(workspace);
    }
  });

  it("delivers agent presets as session system instructions and resumes the session when they change", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "acp-system-"));
    const workspace = process.cwd();
    const provider = new FeatureProvider(() => undefined, state, { FAKE_ECHO_META: "on", FAKE_ECHO_PROMPT: "on", FAKE_LOAD: "on" });
    const agent = { name: "Reviewer", instructions: "Review carefully." };
    await provider.send(workspace, { prompt: "first", configuration: { model: "model-a" }, agent });
    let session = await settle(provider, workspace);
    const first = session.messages.map((message) => message.text).join("\n");
    expect(first).toContain('META:{"systemPrompt":{"append":"Selected agent: Reviewer\\n\\n<agent_instructions>\\nReview carefully.\\n</agent_instructions>"}}');
    expect(first).toContain('PROMPT:[{"type":"text","text":"first"}]');
    expect(session.systemInstructions).toContain("Review carefully.");
    expect(session.context?.sections.find((section) => section.id === "instructions")?.entries.map((entry) => entry.label)).toContain("Agent: Reviewer");

    // A follow-up without an agent keeps the preset; a different preset restarts and resumes with it.
    await provider.send(workspace, { prompt: "second", configuration: {} });
    session = await settle(provider, workspace);
    await provider.send(workspace, { prompt: "third", configuration: {}, agent: { name: "Writer", instructions: "Write tersely." } });
    session = await settle(provider, workspace);
    const latest = session.messages.filter((message) => message.text.startsWith("META:")).at(-1)!.text;
    expect(latest).toContain("Write tersely.");
    expect(session.messages.some((message) => message.text.includes("could not be resumed"))).toBe(false);

    // Turning the switch off falls back to sending the preset inside the prompt.
    await provider.configure(workspace, { agentSystemInstructions: false });
    await provider.send(workspace, { prompt: "fourth", configuration: {}, agent: { name: "Writer", instructions: "Write tersely." } });
    session = await settle(provider, workspace);
    const fallback = session.messages.filter((message) => message.text.startsWith("META:")).at(-1)!.text;
    expect(fallback).toContain("META:null");
    expect(fallback).toContain("<agent_instructions>");
    expect(session.systemInstructions).toBeUndefined();
    await provider.clear(workspace);
  });

  it("reports Claude subscription windows from rate limit metadata", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "claude-limits-"));
    const claude = new ClaudeSessionManager({ onChanged: () => undefined, stateDirectory: state });
    expect((await claude.usage("/no/session")).accountQuota).toBeUndefined();
    claude["observeUsage"]({ "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 4102444800 } });
    claude["observeUsage"]({ "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day_opus", resetsAt: 4102444800 } });
    claude["observeUsage"]({ "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 } });
    const usage = await claude.usage("/no/session");
    expect(usage.accountQuota).toEqual({ limitName: "Claude subscription", primary: { usedPercent: 42, remainingPercent: 58, windowMinutes: 300, resetsAt: "2100-01-01T00:00:00.000Z" }, secondary: { usedPercent: 90, remainingPercent: 10, windowMinutes: 10_080 } });
    expect(usage.details).toMatchObject({ "5-hour limit": "42% used, resets 2100-01-01 00:00 UTC", "Weekly limit · Opus": "100% used, resets 2100-01-01 00:00 UTC (limit reached)", "Weekly limit · all models": "90% used (approaching limit)" });
  });
});
