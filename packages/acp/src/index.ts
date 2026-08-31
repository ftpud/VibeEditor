export type AiStatus = "idle" | "in_progress" | "user_prompt" | "waiting" | "done" | "error";
export type AiProvider = string;
export type AiConfiguration = Record<string, string | number | boolean>;
export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; name?: string }
  | { type: "resource"; uri: string; mimeType?: string; text: string; name?: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; size?: number };
/** `terminalId` is an opaque candidate Core terminal identity. It resolves only in the current workspace and never restores a shell. */
export type AiMessage = { id: string; role: "user" | "assistant" | "activity" | "error"; text: string; content?: AiContentBlock[]; timestamp: string; terminalId?: string; /** Effective model for a generated response. */ model?: string; reasoning?: string; /** Model that originated an automated prompt; absent for human prompts. */ senderModel?: string };
export type AiCommand = { name: string; description: string; inputHint?: string };
export type AiPermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };
export type AiPermissionRequest = { id: string; title: string; toolCallId: string; details?: string; options: AiPermissionOption[] };
export type AiSession = { id?: string; createdAt?: string; updatedAt?: string; threadId?: string; model: string; reasoning: string; configuration?: AiConfiguration; /** One-shot model/reasoning override consumed by the next new turn. */ nextConfiguration?: AiConfiguration; availableOptions?: AiOption[]; availableCommands?: AiCommand[]; pendingPermission?: AiPermissionRequest; status: AiStatus; messages: AiMessage[]; contextUsed?: number; contextLimit?: number; tokens?: AiTokenUsage; steering?: boolean; agent?: { name: string; fingerprint: string } };
export type AiTokenUsage = { total: number; input: number; output: number; thought?: number; cachedRead?: number; cachedWrite?: number };
/**
 * Optional catalogue metadata. Everything here is advertised by the agent (ACP
 * model `_meta`, option descriptions) or read from the CLI's own model cache, so
 * a field is simply absent when the provider does not publish it.
 */
export type AiModelDetails = {
  description?: string;
  /** Relative request cost, e.g. Copilot's "0.33x" premium-request multiplier. */
  price?: string;
  /** Coarse cost bucket advertised alongside the multiplier: low, medium, high, very_high. */
  priceTier?: string;
  /** False when the account cannot use the model (policy, plan or quota). */
  available?: boolean;
  /** Usable context window in tokens. */
  contextWindow?: number;
  /** Largest context window the model can be configured with, when it differs. */
  maxContextWindow?: number;
  /** Accepted prompt content types, e.g. ["text", "image"]. */
  inputModalities?: string[];
  /** Per-reasoning-level explanations keyed by level id. */
  reasoningDescriptions?: Record<string, string>;
  /** Deprecation or migration notice published by the agent. */
  note?: string;
};
export type AiModel = { id: string; name: string; defaultReasoning: string; reasoningLevels: string[] } & AiModelDetails;
export type AiOption = { id: string; name: string; description: string; section?: string; type: "select" | "number" | "boolean" | "text"; defaultValue: string | number | boolean; choices?: { value: string; name: string; description?: string }[]; min?: number; max?: number; modelDependent?: boolean };
export type AiAutopilotOption = { option: AiOption; on: string | boolean; off: string | boolean };
export type AiSettingsSection = { id: string; name: string; description?: string };
export type AiSettingsLayout = { title: string; description: string; sections: AiSettingsSection[] };
export type AiProviderCapabilities = { models: boolean; usage: boolean; mcp: boolean; agents: boolean; contextWindow: boolean };
export type AiProviderDescriptor = { id: AiProvider; name: string; description: string; settings: AiSettingsLayout; options: AiOption[]; capabilities: AiProviderCapabilities };
export type AiQuotaWindow = { usedPercent: number; remainingPercent: number; windowMinutes?: number; resetsAt?: string };
export type AiAccountQuota = {
  plan?: string;
  limitId?: string;
  limitName?: string;
  primary?: AiQuotaWindow;
  secondary?: AiQuotaWindow;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
};
export type AiUsage = { supported: boolean; label?: string; used?: number; limit?: number; unit?: string; resetsAt?: string; details?: Record<string, string | number>; accountQuota?: AiAccountQuota };
export type AiMcpServer =
  | { transport?: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { transport: "http" | "sse"; name: string; url: string; headers?: Record<string, string>; enabled?: boolean };
export type AiAgent = { name: string; description?: string; instructions: string; mcpServers?: string[] };
export type AiTaskSummary = { status: AiStatus; preview: string; additions: number; deletions: number; pendingPermission: boolean; waitingUntil?: string };
export type AcpSendRequest = { prompt: string; content?: AiContentBlock[]; configuration: AiConfiguration; mcpServers?: AiMcpServer[]; agent?: AiAgent };

/** Shared provider contract. Each provider owns its settings UI metadata. */
export abstract class AcpProvider {
  abstract readonly descriptor: AiProviderDescriptor;
  abstract get(workspace: string): Promise<AiSession>;
  abstract models(): Promise<AiModel[]>;
  abstract configure(workspace: string, configuration: AiConfiguration): Promise<AiSession>;
  /** Queues a one-shot configuration override for the next new turn, including while a turn is running. */
  abstract configureNext(workspace: string, configuration: AiConfiguration): Promise<AiSession>;
  abstract send(workspace: string, request: AcpSendRequest): Promise<AiSession>;
  abstract interrupt(workspace: string): Promise<AiSession>;
  abstract resolvePermission(workspace: string, requestId: string, optionId?: string): Promise<AiSession>;
  /** Adds input to a turn that is already running, optionally forcing a distinct follow-up turn. */
  abstract steer(workspace: string, prompt: string, options?: { senderModel?: string; queue?: boolean }): Promise<AiSession>;
  abstract clear(workspace: string): Promise<AiSession>;
  /** Starts a context-empty session. Providers may queue this until a running turn finishes. */
  async startFreshSession(workspace: string, request: AcpSendRequest): Promise<AiSession> {
    const current = await this.get(workspace);
    if (current.status === "in_progress" || current.status === "user_prompt") throw new Error(`${this.descriptor.name} is still working`);
    await this.clear(workspace);
    return this.send(workspace, request);
  }
  /** Every session recorded for the workspace, most recently updated first. */
  abstract sessions(workspace: string): Promise<AiSession[]>;
  /** Makes a previously recorded session the active one again. */
  abstract restore(workspace: string, sessionId: string): Promise<AiSession>;
  /** Forgets a recorded session. Removing the active one starts a fresh session. */
  abstract remove(workspace: string, sessionId: string): Promise<AiSession>;
  async usage(_workspace?: string): Promise<AiUsage> { return { supported: false, label: "Usage is not exposed by this provider" }; }
}

export function mergeConfiguration(session: AiSession, configuration: AiConfiguration): AiConfiguration { return { model: session.model, reasoning: session.reasoning, ...session.configuration, ...configuration }; }
export function applyConfiguration(session: AiSession, configuration: AiConfiguration): void { const merged = mergeConfiguration(session, configuration); if (typeof merged.model === "string") session.model = merged.model; if (typeof merged.reasoning === "string") session.reasoning = merged.reasoning; session.configuration = merged; }

const AUTOPILOT = /autopilot|auto-?approve|yolo|full[- ]?access|bypass|danger|never ?ask/i;

/** Finds the provider option and values that the editor presents as its Autopilot switch. */
export function findAutopilotOption(options: AiOption[]): AiAutopilotOption | undefined {
  const toggle = options.find((option) => option.type === "boolean" && AUTOPILOT.test(`${option.id} ${option.name}`));
  if (toggle) return { option: toggle, on: true, off: false };
  for (const option of options) {
    if (option.type !== "select" || !option.choices) continue;
    const match = option.choices.find((choice) => AUTOPILOT.test(`${choice.value} ${choice.name}`));
    if (!match) continue;
    const fallback = option.choices.find((choice) => String(option.defaultValue) === choice.value && choice.value !== match.value) ?? option.choices.find((choice) => choice.value !== match.value);
    if (fallback) return { option, on: match.value, off: fallback.value };
  }
  return undefined;
}
