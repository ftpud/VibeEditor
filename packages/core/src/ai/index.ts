import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";
import { ClaudeSessionManager } from "./providers/claude.js";
import type { AcpTurnObserver, ProviderContext, ProviderFactory } from "./stdio-provider.js";

/** Built-in providers use the same factory signature as any external one; the first is the registry default. */
export const BUILT_IN_PROVIDERS: ProviderFactory[] = [
  (ctx) => new CodexSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace),
  (ctx) => new CopilotSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace),
  (ctx) => new ClaudeSessionManager(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace)
];

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void, turns?: AcpTurnObserver, projectRoot?: (workspace: string) => Promise<string>, bridgeWorkspace?: string, factories: ProviderFactory[] = BUILT_IN_PROVIDERS): AcpRegistry {
  const ctx: ProviderContext = { onChanged, turns, projectRoot, bridgeWorkspace };
  return factories.reduce((registry, create) => registry.register(create(ctx)), new AcpRegistry());
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export { PROVIDER_API_VERSION, StdioAcpProvider } from "./stdio-provider.js";
export type { ProviderContext, ProviderFactory } from "./stdio-provider.js";
export type { AcpSendRequest } from "./acp.js";
