import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

const FALLBACK_MODELS = ["auto", "claude-sonnet-4.6", "gpt-5.4", "claude-haiku-4.5", "gpt-5.3-codex", "gemini-3.1-pro-preview"];

export class CopilotSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "copilot", name: "Copilot ACP", description: "GitHub Copilot CLI's native Agent Client Protocol server.",
    settings: { title: "Copilot settings", description: "Server-level options are applied when Vibe launches the ACP server for this workspace.", sections: [{ id: "behavior", name: "Behavior", description: "How the ACP agent approaches tasks." }, { id: "limits", name: "Tools & limits", description: "Resource and tool safeguards." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true },
    options: [
      { id: "mode", name: "Agent mode", description: "Select the ACP session mode when the server advertises it.", section: "behavior", type: "select", defaultValue: "interactive", choices: [{ value: "interactive", name: "Interactive" }, { value: "plan", name: "Plan" }, { value: "autopilot", name: "Autopilot" }] },
      { id: "maxAiCredits", name: "Maximum AI credits", description: "Optional per-session spending guard. Set to 0 to use the provider default.", section: "limits", type: "number", defaultValue: 0, min: 0 }
    ]
  };

  protected command(configuration: AiConfiguration): { command: string; args: string[] } {
    const args = ["--acp", "--stdio", `--reasoning-effort=${String(configuration.reasoning ?? "medium")}`];
    if (typeof configuration.maxAiCredits === "number" && configuration.maxAiCredits > 0) args.push(`--max-ai-credits=${configuration.maxAiCredits}`);
    return { command: process.env.COPILOT_CLI_PATH ?? "copilot", args };
  }

  protected async fallbackModels(): Promise<AiModel[]> { return FALLBACK_MODELS.map((id) => ({ id, name: id === "auto" ? "Auto" : id, defaultReasoning: "medium", reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] })); }
}
