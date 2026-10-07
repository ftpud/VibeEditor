import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";
import type { AcpTurnObserver } from "./stdio-provider.js";

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void, turns?: AcpTurnObserver, projectRoot?: (workspace: string) => Promise<string>, bridgeWorkspace?: string): AcpRegistry {
  return new AcpRegistry()
    .register(new CodexSessionManager(onChanged, undefined, turns, projectRoot, bridgeWorkspace))
    .register(new CopilotSessionManager(onChanged, undefined, turns, projectRoot, bridgeWorkspace));
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export type { AcpSendRequest } from "./acp.js";
