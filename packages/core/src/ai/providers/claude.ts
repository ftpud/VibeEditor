import { createRequire } from "node:module";
import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider } from "../stdio-provider.js";

const require = createRequire(import.meta.url);
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Used only when the Claude ACP server cannot be reached; the live list wins. */
const FALLBACK_MODELS: AiModel[] = [
  { id: "default", name: "Default", defaultReasoning: "", reasoningLevels: [] },
  { id: "fable", name: "Fable", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "opus", name: "Opus", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "sonnet", name: "Sonnet", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "haiku", name: "Haiku", defaultReasoning: "", reasoningLevels: [] }
];

export class ClaudeSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "claude", name: "Claude ACP", description: "Claude Code through the Agent Client Protocol adapter built on the Claude Agent SDK.",
    settings: { title: "Claude settings", description: "Permission handling for this workspace's Claude session.", sections: [{ id: "tools", name: "Tools & access", description: "How Claude asks before acting." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true, skills: true },
    options: [
      { id: "mode", name: "Permission mode", description: "Choose how Claude asks before editing files and running tools. Modes the agent does not advertise are ignored.", section: "tools", type: "select", defaultValue: "default", choices: [{ value: "default", name: "Manual" }, { value: "acceptEdits", name: "Accept edits" }, { value: "plan", name: "Plan" }, { value: "auto", name: "Auto" }, { value: "bypassPermissions", name: "Bypass permissions" }] },
      { id: "autopilot", name: "Autopilot", description: "Approve tool permission requests automatically for this session.", section: "tools", type: "boolean", defaultValue: false, permissionApproval: true }
    ]
  };

  /** The adapter bundles the Claude Code CLI; `CLAUDE_CODE_EXECUTABLE` overrides it through the inherited environment. */
  protected command(_configuration: AiConfiguration): { command: string; args: string[] } {
    return { command: process.execPath, args: [process.env.CLAUDE_AGENT_ACP_PATH ?? require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")] };
  }

  protected async fallbackModels(): Promise<AiModel[]> { return FALLBACK_MODELS; }
}
