import crypto from "node:crypto";
import type { AiAgent } from "@remote-ide/acp";

/** Stable identity for the preset instructions attached to a durable AI session. */
export function agentFingerprint(agent: AiAgent): string {
  return crypto.createHash("sha256").update(JSON.stringify([agent.name, agent.description ?? "", agent.instructions.trim()])).digest("hex");
}
