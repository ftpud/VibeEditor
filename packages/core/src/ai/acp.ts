import type { AiAgent, AiConfiguration, AiMcpServer, AiModel, AiProviderDescriptor, AiSession, AiUsage } from "@remote-ide/protocol";
import { CoreError } from "../errors.js";

/** Stable application-facing contract implemented by every AI provider plugin. */
export type AcpSendRequest = {
  prompt: string;
  configuration: AiConfiguration;
  mcpServers?: AiMcpServer[];
  agent?: AiAgent;
};

export abstract class AcpProvider {
  abstract readonly descriptor: AiProviderDescriptor;
  abstract get(workspace: string): Promise<AiSession>;
  abstract models(): Promise<AiModel[]>;
  abstract configure(workspace: string, configuration: AiConfiguration): Promise<AiSession>;
  abstract send(workspace: string, request: AcpSendRequest): Promise<AiSession>;
  abstract clear(workspace: string): Promise<AiSession>;
  async usage(): Promise<AiUsage> { return { supported: false, label: "Usage is not exposed by this provider" }; }
}

/** Runtime registry: new providers are added by registering one AcpProvider plugin. */
export class AcpRegistry {
  private readonly providers = new Map<string, AcpProvider>();

  register(provider: AcpProvider): this {
    if (this.providers.has(provider.descriptor.id)) throw new Error(`ACP provider '${provider.descriptor.id}' is already registered`);
    this.providers.set(provider.descriptor.id, provider);
    return this;
  }

  list(): AiProviderDescriptor[] { return [...this.providers.values()].map((provider) => provider.descriptor); }

  get(id = "codex"): AcpProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new CoreError("INVALID_REQUEST", `Unknown AI provider '${id}'`);
    return provider;
  }
}

export function mergeConfiguration(session: AiSession, configuration: AiConfiguration): AiConfiguration {
  return { model: session.model, reasoning: session.reasoning, ...session.configuration, ...configuration };
}

export function applyConfiguration(session: AiSession, configuration: AiConfiguration): void {
  const merged = mergeConfiguration(session, configuration);
  if (typeof merged.model === "string") session.model = merged.model;
  if (typeof merged.reasoning === "string") session.reasoning = merged.reasoning;
  session.configuration = merged;
}
