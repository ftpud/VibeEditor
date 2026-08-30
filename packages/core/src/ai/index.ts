import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";
import type { AcpTurnObserver } from "./stdio-provider.js";

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void, turns?: AcpTurnObserver): AcpRegistry {
  return new AcpRegistry()
    .register(new CodexSessionManager(onChanged, undefined, turns))
    .register(new CopilotSessionManager(onChanged, undefined, turns));
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export type { AcpSendRequest } from "./acp.js";
