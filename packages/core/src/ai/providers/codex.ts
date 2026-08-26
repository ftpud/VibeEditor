import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

const require = createRequire(import.meta.url);

export class CodexSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "codex", name: "Codex ACP", description: "Codex through the standard Agent Client Protocol.",
    settings: { title: "Codex settings", description: "These settings are applied through ACP session modes and configuration options.", sections: [{ id: "tools", name: "Tools & access", description: "Capabilities available while Codex works." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true },
    options: [
      { id: "mode", name: "Agent mode", description: "Choose read-only analysis, normal workspace editing, or full access when advertised by the ACP server.", section: "tools", type: "select", defaultValue: "agent", choices: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Workspace agent" }, { value: "agent-full-access", name: "Full access" }] },
      { id: "webSearch", name: "Web search", description: "Allow Codex to search the web when the ACP server exposes this option.", section: "tools", type: "boolean", defaultValue: false }
    ]
  };

  protected command(configuration: AiConfiguration): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    return { command: process.execPath, args: [require.resolve("@agentclientprotocol/codex-acp")], env: { INITIAL_AGENT_MODE: String(configuration.mode ?? "agent"), CODEX_CONFIG: JSON.stringify({ features: { web_search: configuration.webSearch === true } }) } };
  }

  protected async fallbackModels(): Promise<AiModel[]> {
    try {
      const cache = JSON.parse(await readFile(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8")) as { models?: Record<string, unknown>[] };
      return (cache.models ?? []).filter((item) => item.visibility !== "hidden" && typeof item.slug === "string").map((item) => ({ id: item.slug as string, name: typeof item.display_name === "string" ? item.display_name : item.slug as string, defaultReasoning: typeof item.default_reasoning_level === "string" ? item.default_reasoning_level : "medium", reasoningLevels: Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.map((level) => (level as { effort?: unknown }).effort).filter((effort): effort is string => typeof effort === "string") : ["medium"] }));
    } catch { return [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh"] }]; }
  }
}
