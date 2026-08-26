import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

/** Used only when the Copilot ACP server cannot be reached; the live list wins. */
const FALLBACK_MODELS: { id: string; name: string; reasoningLevels: string[]; price: string; priceTier: string }[] = [
  { id: "auto", name: "Auto", reasoningLevels: [], price: "", priceTier: "" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], price: "1x", priceTier: "medium" },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", reasoningLevels: ["low", "medium", "high", "max"], price: "1x", priceTier: "medium" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", reasoningLevels: [], price: "0.33x", priceTier: "low" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"], price: "1x", priceTier: "medium" },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", reasoningLevels: ["low", "medium", "high", "xhigh"], price: "1x", priceTier: "medium" }
];

export class CopilotSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "copilot", name: "Copilot ACP", description: "GitHub Copilot CLI's native Agent Client Protocol server.",
    settings: { title: "Copilot settings", description: "Server-level options are applied when Vibe launches the ACP server for this workspace.", sections: [{ id: "limits", name: "Tools & limits", description: "Resource and tool safeguards." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true },
    options: [
      { id: "maxAiCredits", name: "Maximum AI credits", description: "Optional per-session spending guard. Set to 0 to use the provider default.", section: "limits", type: "number", defaultValue: 0, min: 0 }
    ]
  };

  protected command(configuration: AiConfiguration): { command: string; args: string[] } {
    const args = ["--acp", "--stdio"];
    const fixedModel = typeof configuration.model === "string" && configuration.model && configuration.model !== "auto";
    if (fixedModel) args.push(`--model=${configuration.model}`);
    if (fixedModel && typeof configuration.reasoning === "string" && configuration.reasoning && configuration.reasoning !== "none") args.push(`--reasoning-effort=${configuration.reasoning}`);
    if (typeof configuration.maxAiCredits === "number" && configuration.maxAiCredits > 0) args.push(`--max-ai-credits=${configuration.maxAiCredits}`);
    return { command: process.env.COPILOT_CLI_PATH ?? "copilot", args };
  }

  protected async fallbackModels(): Promise<AiModel[]> {
    return FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name, defaultReasoning: model.reasoningLevels.includes("medium") ? "medium" : "", reasoningLevels: model.reasoningLevels, ...(model.price ? { price: model.price, priceTier: model.priceTier } : {}) }));
  }
}
