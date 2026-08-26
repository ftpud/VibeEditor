import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

/** Used only when the Copilot ACP server cannot be reached; the live list wins. */
const FALLBACK_MODELS: [string, string, string[]][] = [
  ["auto", "Auto", []],
  ["claude-sonnet-5", "Claude Sonnet 5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", ["low", "medium", "high", "max"]],
  ["claude-haiku-4.5", "Claude Haiku 4.5", []],
  ["gpt-5.6-sol", "GPT-5.6 Sol", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.3-codex", "GPT-5.3-Codex", ["low", "medium", "high", "xhigh"]]
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
    // Reasoning effort is deliberately not passed on the command line: the CLI
    // rejects it outright for models that have no effort levels. The ACP
    // `reasoning_effort` config option applies it against the selected model.
    const args = ["--acp", "--stdio"];
    if (typeof configuration.maxAiCredits === "number" && configuration.maxAiCredits > 0) args.push(`--max-ai-credits=${configuration.maxAiCredits}`);
    return { command: process.env.COPILOT_CLI_PATH ?? "copilot", args };
  }

  protected async fallbackModels(): Promise<AiModel[]> {
    return FALLBACK_MODELS.map(([id, name, reasoningLevels]) => ({ id, name, defaultReasoning: reasoningLevels.includes("medium") ? "medium" : "", reasoningLevels }));
  }
}
