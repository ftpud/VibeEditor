import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AiAccountQuota, AiQuotaWindow } from "@remote-ide/acp";

type JsonRecord = Record<string, unknown>;

export async function readCodexAccountQuota(command: string, args: string[], timeoutMs = 5_000): Promise<AiAccountQuota | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (quota?: AiAccountQuota) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(quota);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("error", () => finish());
    child.once("exit", () => finish());
    child.stdin.on("error", () => finish());
    lines.on("line", (line) => {
      let message: JsonRecord;
      try { message = JSON.parse(line) as JsonRecord; } catch { return; }
      if (message.id === 1 && message.result) {
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: null })}\n`);
      } else if (message.id === 2) {
        finish(parseCodexAccountQuota(message.result));
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "vibe-editor", title: "Vibe Editor", version: "0.1.0" }, capabilities: {} } })}\n`);
  });
}

export function parseCodexAccountQuota(value: unknown): AiAccountQuota | undefined {
  const result = record(value);
  const rateLimits = record(result?.rateLimits);
  if (!rateLimits) return undefined;
  const primary = quotaWindow(rateLimits.primary);
  const secondary = quotaWindow(rateLimits.secondary);
  const credits = record(rateLimits.credits);
  return {
    ...(typeof rateLimits.planType === "string" ? { plan: rateLimits.planType } : {}),
    ...(typeof rateLimits.limitId === "string" ? { limitId: rateLimits.limitId } : {}),
    ...(typeof rateLimits.limitName === "string" ? { limitName: rateLimits.limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean" ? {
      credits: { hasCredits: credits.hasCredits, unlimited: credits.unlimited, ...(typeof credits.balance === "string" ? { balance: credits.balance } : {}) }
    } : {})
  };
}

function quotaWindow(value: unknown): AiQuotaWindow | undefined {
  const window = record(value);
  if (!window || typeof window.usedPercent !== "number") return undefined;
  return {
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    ...(typeof window.windowDurationMins === "number" ? { windowMinutes: window.windowDurationMins } : {}),
    ...(typeof window.resetsAt === "number" ? { resetsAt: new Date(window.resetsAt * 1_000).toISOString() } : {})
  };
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
