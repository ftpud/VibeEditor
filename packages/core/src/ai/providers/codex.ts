import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

const require = createRequire(import.meta.url);
const WEB_SEARCH_MODES = ["live", "indexed", "cached", "disabled"];

export class CodexSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "codex", name: "Codex ACP", description: "Codex through the standard Agent Client Protocol.",
    settings: { title: "Codex settings", description: "These settings are applied through ACP session modes and configuration options.", sections: [{ id: "tools", name: "Tools & access", description: "Capabilities available while Codex works." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true },
    options: [
      { id: "mode", name: "Agent mode", description: "Choose read-only analysis, normal workspace editing, or full access when advertised by the ACP server.", section: "tools", type: "select", defaultValue: "agent", choices: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Workspace agent" }, { value: "agent-full-access", name: "Full access" }] },
      { id: "webSearch", name: "Web search", description: "Codex searches the web by default. Choose a different source, or disable it entirely.", section: "tools", type: "select", defaultValue: "default", choices: [{ value: "default", name: "Codex default" }, { value: "live", name: "Live" }, { value: "indexed", name: "Indexed" }, { value: "cached", name: "Cached" }, { value: "disabled", name: "Disabled" }] }
    ]
  };

  protected command(configuration: AiConfiguration): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    // `features.web_search` is deprecated and makes Codex emit an error item on
    // every turn; the supported form is a top-level `web_search` source mode.
    const webSearch = String(configuration.webSearch ?? "default");
    const config = WEB_SEARCH_MODES.includes(webSearch) ? { web_search: webSearch } : {};
    return { command: process.execPath, args: [require.resolve("@agentclientprotocol/codex-acp")], env: { INITIAL_AGENT_MODE: String(configuration.mode ?? "agent"), CODEX_CONFIG: JSON.stringify(config) } };
  }

  protected async fallbackModels(): Promise<AiModel[]> {
    try {
      const cache = JSON.parse(await readFile(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8")) as { models?: Record<string, unknown>[] };
      // Codex marks catalogue entries as "list" or "hide"; anything not explicitly listed is internal.
      const models = (cache.models ?? []).filter((item) => item.visibility === "list" && typeof item.slug === "string").map((item) => ({ id: item.slug as string, name: typeof item.display_name === "string" ? item.display_name : item.slug as string, defaultReasoning: typeof item.default_reasoning_level === "string" ? item.default_reasoning_level : "medium", reasoningLevels: Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.map((level) => (level as { effort?: unknown }).effort).filter((effort): effort is string => typeof effort === "string") : ["medium"] }));
      if (models.length > 0) return models;
    } catch { /* fall through to the built-in default */ }
    return [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] }];
  }
}
