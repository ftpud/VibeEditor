import { AcpProvider, type AiProviderDescriptor, type AiProviderInstallation } from "@remote-ide/acp";
import { CoreError } from "../errors.js";

/** Runtime registry: new providers are added by registering one AcpProvider plugin. */
export class AcpRegistry {
  private readonly providers = new Map<string, AcpProvider>();

  register(provider: AcpProvider): this {
    if (this.providers.has(provider.descriptor.id)) throw new Error(`ACP provider '${provider.descriptor.id}' is already registered`);
    this.providers.set(provider.descriptor.id, provider);
    return this;
  }

  /** Every registered provider, including those whose agent is not installed. */
  list(): AiProviderDescriptor[] { return [...this.providers.values()].map((provider) => provider.descriptor); }

  /** Providers whose agent is installed on the Core host; only these are offered to clients. */
  async available(): Promise<AiProviderDescriptor[]> {
    const states = await Promise.all([...this.providers.values()].map(async (provider) => ({ provider, state: await provider.installation().catch(() => undefined) })));
    return states.filter(({ state }) => state?.status === "installed" || !!state?.version).map(({ provider }) => provider.descriptor);
  }

  installations(checkLatest = false): Promise<AiProviderInstallation[]> { return Promise.all([...this.providers.values()].map((provider) => provider.installation(checkLatest))); }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.providers.values()].map((provider) => provider.shutdown()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not shut down AI providers");
  }

  /** The provider used when a request names none: the first one registered. */
  get defaultId(): string {
    const first = this.providers.keys().next();
    if (first.done) throw new CoreError("INVALID_REQUEST", "No AI provider is registered");
    return first.value;
  }

  get(id: string = this.defaultId): AcpProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new CoreError("INVALID_REQUEST", `Unknown AI provider '${id}'`);
    return provider;
  }
}

export { AcpProvider, applyConfiguration, mergeConfiguration } from "@remote-ide/acp";
export type { AcpSendRequest } from "@remote-ide/acp";
