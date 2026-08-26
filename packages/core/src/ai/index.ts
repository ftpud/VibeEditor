import { AcpRegistry } from "./acp.js";
import { CodexSessionManager } from "./providers/codex.js";
import { CopilotSessionManager } from "./providers/copilot.js";

/** Application composition root for built-in and externally supplied providers. */
export function createAcpRegistry(onChanged: (workspace: string) => void): AcpRegistry {
  return new AcpRegistry()
    .register(new CodexSessionManager(onChanged))
    .register(new CopilotSessionManager(onChanged));
}

export { AcpProvider, AcpRegistry } from "./acp.js";
export type { AcpSendRequest } from "./acp.js";
