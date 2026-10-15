import { AcpProvider, type AiProviderDescriptor } from "@remote-ide/acp";
import { CoreError } from "../errors.js";

/** Runtime registry: new providers are added by registering one AcpProvider plugin. */
export class AcpRegistry {
  private readonly providers = new Map<string, AcpProvider>();

  register(provider: AcpProvider): this {
    if (this.providers.has(provider.descriptor.id)) throw new Error(`ACP provider '${provider.descriptor.id}' is already registered`);
    this.providers.set(provider.descriptor.id, provider);
    return this;
  }

  list(): AiProviderDescriptor[] { return [...this.providers.values()].map((provider) => provider.descriptor); }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.providers.values()].map((provider) => provider.shutdown()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not shut down AI providers");
  }

  get(id = "codex"): AcpProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new CoreError("INVALID_REQUEST", `Unknown AI provider '${id}'`);
    return provider;
  }
}

export { AcpProvider, applyConfiguration, mergeConfiguration } from "@remote-ide/acp";
export type { AcpSendRequest } from "@remote-ide/acp";
