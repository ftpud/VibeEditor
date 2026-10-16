import { createRequire } from "node:module";
import type { AiAccountQuota, AiConfiguration, AiModel, AiProviderDescriptor, AiQuotaWindow, AiUsage } from "@remote-ide/acp";
import { ASK_QUESTIONS_OPTION, LIVE_STEERING_OPTION, StdioAcpProvider, SYSTEM_INSTRUCTIONS_OPTION } from "../stdio-provider.js";

const require = createRequire(import.meta.url);
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const RATE_LIMIT_META = "_claude/rateLimit";
const WINDOW_LABELS: Record<string, { label: string; minutes?: number }> = {
  five_hour: { label: "5-hour limit", minutes: 300 },
  seven_day: { label: "Weekly limit · all models", minutes: 10_080 },
  seven_day_opus: { label: "Weekly limit · Opus", minutes: 10_080 },
  seven_day_sonnet: { label: "Weekly limit · Sonnet", minutes: 10_080 },
  seven_day_overage_included: { label: "Weekly limit · including extra usage", minutes: 10_080 },
  overage: { label: "Extra usage" }
};

/** Used only when the Claude ACP server cannot be reached; the live list wins. */
const FALLBACK_MODELS: AiModel[] = [
  { id: "default", name: "Default", defaultReasoning: "", reasoningLevels: [] },
  { id: "fable", name: "Fable", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "opus", name: "Opus", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "sonnet", name: "Sonnet", defaultReasoning: "medium", reasoningLevels: REASONING_LEVELS },
  { id: "haiku", name: "Haiku", defaultReasoning: "", reasoningLevels: [] }
];

type RateLimit = { status?: string; window: AiQuotaWindow };

export class ClaudeSessionManager extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = {
    id: "claude", name: "Claude ACP", description: "Claude Code through the Agent Client Protocol adapter built on the Claude Agent SDK.",
    settings: { title: "Claude settings", description: "Permission handling and session features for this workspace's Claude session.", sections: [{ id: "tools", name: "Tools & access", description: "How Claude asks before acting." }, { id: "features", name: "Session features", description: "How Vibe Editor works with the running session." }] },
    capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true, skills: true },
    options: [
      { id: "mode", name: "Permission mode", description: "Choose how Claude asks before editing files and running tools. Modes the agent does not advertise are ignored.", section: "tools", type: "select", defaultValue: "default", choices: [{ value: "default", name: "Manual" }, { value: "acceptEdits", name: "Accept edits" }, { value: "plan", name: "Plan" }, { value: "auto", name: "Auto" }, { value: "bypassPermissions", name: "Bypass permissions" }] },
      { id: "autopilot", name: "Autopilot", description: "Approve tool permission requests automatically for this session.", section: "tools", type: "boolean", defaultValue: false, permissionApproval: true },
      { ...ASK_QUESTIONS_OPTION, section: "features" },
      { ...LIVE_STEERING_OPTION, section: "features" },
      { ...SYSTEM_INSTRUCTIONS_OPTION, section: "features" }
    ]
  };

  /** Account-wide subscription windows, as last reported by any session. */
  private readonly rateLimits = new Map<string, RateLimit>();

  /** The adapter bundles the Claude Code CLI; `CLAUDE_CODE_EXECUTABLE` overrides it through the inherited environment. */
  protected command(_configuration: AiConfiguration): { command: string; args: string[] } {
    return { command: process.execPath, args: [process.env.CLAUDE_AGENT_ACP_PATH ?? require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")] };
  }

  protected async fallbackModels(): Promise<AiModel[]> { return FALLBACK_MODELS; }

  /** The adapter appends `systemPrompt.append` to the Claude Code system prompt, also when resuming. */
  protected sessionInstructionsMeta(instructions: string): Record<string, unknown> { return { systemPrompt: { append: instructions } }; }

  protected observeUsage(meta: Record<string, unknown> | undefined): void {
    const info = meta?.[RATE_LIMIT_META] as { status?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown } | undefined;
    if (!info || typeof info.rateLimitType !== "string") return;
    const status = typeof info.status === "string" ? info.status : undefined;
    // Utilization is reported as a fraction; a rejected window is exhausted whatever it reports.
    const fraction = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? (info.utilization > 1 ? info.utilization / 100 : info.utilization) : undefined;
    const usedPercent = status === "rejected" ? 100 : fraction === undefined ? undefined : Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
    const previous = this.rateLimits.get(info.rateLimitType);
    const resetsAt = typeof info.resetsAt === "number" && info.resetsAt > 0 ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString() : previous?.window.resetsAt;
    const used = usedPercent ?? previous?.window.usedPercent;
    if (used === undefined) return;
    const minutes = WINDOW_LABELS[info.rateLimitType]?.minutes;
    this.rateLimits.set(info.rateLimitType, { status, window: { usedPercent: used, remainingPercent: Math.max(0, 100 - used), ...(minutes ? { windowMinutes: minutes } : {}), ...(resetsAt ? { resetsAt } : {}) } });
  }

  /** Subscription windows arrive with turns, so they appear after the first turn since Core started. */
  async usage(workspace?: string): Promise<AiUsage> {
    const usage = await super.usage(workspace);
    if (this.rateLimits.size === 0) return usage;
    const details: Record<string, string | number> = { ...usage.details };
    for (const [id, limit] of this.rateLimits) {
      const reset = limit.window.resetsAt ? `, resets ${limit.window.resetsAt.replace("T", " ").slice(0, 16)} UTC` : "";
      details[WINDOW_LABELS[id]?.label ?? id] = `${limit.window.usedPercent}% used${reset}${limit.status === "rejected" ? " (limit reached)" : limit.status === "allowed_warning" ? " (approaching limit)" : ""}`;
    }
    const primary = this.rateLimits.get("five_hour")?.window;
    const secondary = this.rateLimits.get("seven_day")?.window;
    const accountQuota: AiAccountQuota = { limitName: "Claude subscription", ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
    return { ...usage, supported: true, details, ...(primary || secondary ? { accountQuota } : {}) };
  }
}
