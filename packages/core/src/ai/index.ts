import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";
import { ClaudeSessionManager } from "./providers/claude.js";
import { definitionFactory, loadProviderDefinitions } from "./provider-definitions.js";
import type { AcpTurnObserver, ProviderContext, ProviderFactory } from "./stdio-provider.js";

/** Built-in providers use the same factory signature as any external one; the first is the registry default. */
export const BUILT_IN_PROVIDERS: ProviderFactory[] = [
  (ctx) => new CodexSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace),
  (ctx) => new CopilotSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace),
  (ctx) => new ClaudeSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace)
];

/** A throwing plugin factory is logged and skipped so it cannot break startup or other providers. */
function isolated(create: ProviderFactory): ProviderFactory {
  return (ctx) => {
    try { return create(ctx); } catch (error) { console.warn(`Plugin provider failed to start: ${error instanceof Error ? error.message : String(error)}`); return undefined as never; }
  };
}

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void, turns?: AcpTurnObserver, projectRoot?: (workspace: string) => Promise<string>, bridgeWorkspace?: string, additional: ProviderFactory[] = [], factories: ProviderFactory[] = [...BUILT_IN_PROVIDERS, ...loadProviderDefinitions().map(definitionFactory), ...additional.map(isolated)]): AcpRegistry {
  const ctx: ProviderContext = { onChanged, turns, projectRoot, bridgeWorkspace };
  return factories.reduce((registry, create) => { const provider = create(ctx); return provider ? registry.register(provider) : registry; }, new AcpRegistry());
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export { ConfiguredStdioProvider, loadProviderDefinitions, validateProviderDefinition } from "./provider-definitions.js";
export type { ProviderDefinition } from "./provider-definitions.js";
export { PROVIDER_API_VERSION, StdioAcpProvider } from "./stdio-provider.js";
export type { ProviderContext, ProviderFactory } from "./stdio-provider.js";
export type { AcpSendRequest } from "./acp.js";
