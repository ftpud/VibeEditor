import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexSessionManager } from "./codex.js";
import { CopilotSessionManager, parseCopilotModels } from "./copilot.js";
import { execInShell } from "../../shell-process.js";
import { AcpRegistry } from "../acp.js";

describe("AI CLI integration", () => {
  it("discovers and deduplicates models provided by Copilot completion", () => {
    const models = parseCopilotModels("--model) COMPREPLY=( $(compgen -W 'auto GPT-5.4 claude-sonnet-4.6 gpt-5.4' -- \"$cur\") )");
    expect(models.map((model) => model.id)).toEqual(["auto", "gpt-5.4", "claude-sonnet-4.6"]);
  });

  it("runs commands through the login shell without interpolating arguments", async () => {
    const marker = "value with spaces; $(not-a-command)";
    const result = await execInShell("printf", ["%s", marker], { encoding: "utf8", timeout: 10_000 });
    expect(result.stdout).toBe(marker);
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

  it("discovers providers through the ACP registry and rejects unknown plugins", () => {
    const registry = new AcpRegistry().register(new CodexSessionManager(() => undefined));
    expect(registry.list().map((provider) => provider.id)).toEqual(["codex"]);
    expect(() => registry.get("missing")).toThrow("Unknown AI provider");
  });
});
