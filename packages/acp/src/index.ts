export type AiStatus = "idle" | "in_progress" | "user_prompt" | "done" | "error";
export type AiProvider = string;
export type AiConfiguration = Record<string, string | number | boolean>;
export type AiMessage = { id: string; role: "user" | "assistant" | "activity" | "error"; text: string; timestamp: string };
export type AiSession = { threadId?: string; model: string; reasoning: string; configuration?: AiConfiguration; availableOptions?: AiOption[]; status: AiStatus; messages: AiMessage[]; contextUsed?: number; contextLimit?: number; tokens?: AiTokenUsage };
export type AiTokenUsage = { total: number; input: number; output: number; thought?: number; cachedRead?: number; cachedWrite?: number };
export type AiModel = { id: string; name: string; defaultReasoning: string; reasoningLevels: string[] };
export type AiOption = { id: string; name: string; description: string; section?: string; type: "select" | "number" | "boolean" | "text"; defaultValue: string | number | boolean; choices?: { value: string; name: string; description?: string }[]; min?: number; max?: number; modelDependent?: boolean };
export type AiSettingsSection = { id: string; name: string; description?: string };
export type AiSettingsLayout = { title: string; description: string; sections: AiSettingsSection[] };
export type AiProviderCapabilities = { models: boolean; usage: boolean; mcp: boolean; agents: boolean; contextWindow: boolean };
export type AiProviderDescriptor = { id: AiProvider; name: string; description: string; settings: AiSettingsLayout; options: AiOption[]; capabilities: AiProviderCapabilities };
export type AiUsage = { supported: boolean; label?: string; used?: number; limit?: number; unit?: string; resetsAt?: string; details?: Record<string, string | number> };
export type AiMcpServer = { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean };
export type AiAgent = { name: string; description?: string; instructions: string; mcpServers?: string[] };
export type AiTaskSummary = { status: AiStatus; preview: string; additions: number; deletions: number };
export type AcpSendRequest = { prompt: string; configuration: AiConfiguration; mcpServers?: AiMcpServer[]; agent?: AiAgent };

/** Shared provider contract. Each provider owns its settings UI metadata. */
export abstract class AcpProvider {
  abstract readonly descriptor: AiProviderDescriptor;
  abstract get(workspace: string): Promise<AiSession>;
  abstract models(): Promise<AiModel[]>;
  abstract configure(workspace: string, configuration: AiConfiguration): Promise<AiSession>;
  abstract send(workspace: string, request: AcpSendRequest): Promise<AiSession>;
  abstract interrupt(workspace: string): Promise<AiSession>;
  abstract clear(workspace: string): Promise<AiSession>;
  async usage(_workspace?: string): Promise<AiUsage> { return { supported: false, label: "Usage is not exposed by this provider" }; }
}

export function mergeConfiguration(session: AiSession, configuration: AiConfiguration): AiConfiguration { return { model: session.model, reasoning: session.reasoning, ...session.configuration, ...configuration }; }
export function applyConfiguration(session: AiSession, configuration: AiConfiguration): void { const merged = mergeConfiguration(session, configuration); if (typeof merged.model === "string") session.model = merged.model; if (typeof merged.reasoning === "string") session.reasoning = merged.reasoning; session.configuration = merged; }
