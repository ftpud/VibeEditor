import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";
import { ClaudeSessionManager } from "./providers/claude.js";
import { definitionFactory, loadProviderDefinitions } from "./provider-definitions.js";
import type { AiProviderOrigin } from "@remote-ide/acp";
import type { AcpTurnObserver, ProviderContext, ProviderFactory } from "./stdio-provider.js";

/** Built-in providers use the same factory signature as any external one; the first is the registry default. */
export const BUILT_IN_PROVIDERS: ProviderFactory[] = [
  (ctx) => new CodexSessionManager(ctx),
  (ctx) => new CopilotSessionManager(ctx),
  (ctx) => new ClaudeSessionManager(ctx)
];

/** A throwing plugin factory is logged and skipped so it cannot break startup or other providers. */
function isolated(create: ProviderFactory): ProviderFactory {
  return (ctx) => {
    try { return create(ctx); } catch (error) { console.warn(`Plugin provider failed to start: ${error instanceof Error ? error.message : String(error)}`); return undefined as never; }
  };
}

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void, turns?: AcpTurnObserver, projectRoot?: (workspace: string) => Promise<string>, bridgeWorkspace?: string, plugins: ProviderFactory[] = [], builtIns: ProviderFactory[] = BUILT_IN_PROVIDERS): AcpRegistry {
  const ctx: ProviderContext = { onChanged, turns, projectRoot, bridgeWorkspace };
  const sources: { origin: AiProviderOrigin; factories: ProviderFactory[] }[] = [
    { origin: "built-in", factories: builtIns },
    { origin: "definition", factories: loadProviderDefinitions().map(definitionFactory) },
    { origin: "plugin", factories: plugins.map(isolated) }
  ];
  const registry = new AcpRegistry();
  for (const { origin, factories } of sources) for (const create of factories) {
    const provider = create(ctx);
    if (!provider) continue;
    // Definitions and plugins must never take down startup, even on an ID collision the manifest could not predict.
    if (origin === "built-in") registry.register(provider, origin);
    else try { registry.register(provider, origin); } catch (error) { console.warn(`Skipping ${origin} provider: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return registry;
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export { ConfiguredStdioProvider, loadProviderDefinitions, validateProviderDefinition } from "./provider-definitions.js";
export type { ProviderDefinition } from "./provider-definitions.js";
export { PROVIDER_API_VERSION, StdioAcpProvider } from "./stdio-provider.js";
export type { ProviderContext, ProviderFactory } from "./stdio-provider.js";
export type { AcpSendRequest } from "./acp.js";
