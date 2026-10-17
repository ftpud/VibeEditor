import path from "node:path";
import { CoreError } from "../errors.js";
import type { LanguageDescriptor, LanguageService } from "./service.js";

/** Creates a service for one workspace root; called lazily and at most once per root and language. */
export type LanguageServiceFactory = (workspace: string) => LanguageService;

interface Registration { descriptor: LanguageDescriptor; create: LanguageServiceFactory }

/**
 * Registry of language services. Descriptors are cheap and known up front;
 * services (and the processes behind them) are created on first use per root,
 * so a workspace without Java never starts a JDK or language server.
 */
export class LanguageRegistry {
  private readonly registrations = new Map<string, Registration>();

  register(descriptor: LanguageDescriptor, create: LanguageServiceFactory): this {
    if (!/^[a-z0-9-]+$/.test(descriptor.id)) throw new Error(`Invalid language id '${descriptor.id}'`);
    if (this.registrations.has(descriptor.id)) throw new Error(`Language '${descriptor.id}' is already registered`);
    this.registrations.set(descriptor.id, { descriptor, create });
    return this;
  }

  list(): LanguageDescriptor[] { return [...this.registrations.values()].map((entry) => entry.descriptor); }

  descriptor(id: string): LanguageDescriptor {
    const entry = this.registrations.get(id);
    if (!entry) throw new CoreError("INVALID_REQUEST", `Unknown language '${id}'`);
    return entry.descriptor;
  }

  /** Language for a file by extension, or undefined when no service claims it. */
  forFile(file: string): LanguageDescriptor | undefined {
    const extension = path.extname(file).slice(1).toLowerCase();
    return extension ? this.list().find((descriptor) => descriptor.extensions.includes(extension)) : undefined;
  }

  /** Languages whose marker files appear in `entries` (names directly inside the workspace root). */
  detectMarkers(entries: readonly string[]): LanguageDescriptor[] {
    const names = new Set(entries);
    return this.list().filter((descriptor) => descriptor.projectMarkers.some((marker) => names.has(marker)));
  }

  create(id: string, workspace: string): LanguageService {
    const entry = this.registrations.get(id);
    if (!entry) throw new CoreError("INVALID_REQUEST", `Unknown language '${id}'`);
    return entry.create(workspace);
  }
}

/** Per-root cache of live services with guaranteed disposal. */
export class LanguageSessions {
  private readonly services = new Map<string, LanguageService>();
  constructor(readonly registry: LanguageRegistry, private readonly workspace: string) {}

  get(id: string): LanguageService {
    let service = this.services.get(id);
    if (!service) { service = this.registry.create(id, this.workspace); this.services.set(id, service); }
    return service;
  }

  /** Throws a stable error when a capability is not advertised, so routes never call unsupported operations. */
  require(id: string, capability: keyof LanguageDescriptor["capabilities"]): LanguageService {
    if (!this.registry.descriptor(id).capabilities[capability]) throw new CoreError("INVALID_REQUEST", `Language '${id}' does not support ${capability}`);
    return this.get(id);
  }

  async dispose(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    const results = await Promise.allSettled(services.map((service) => service.dispose()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not dispose language services");
  }
}
