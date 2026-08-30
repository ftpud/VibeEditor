export type ConnectionRuntime = { status: "unknown" | "reconnecting" | "online" | "slow" | "offline"; message: string; latencyMs?: number };

export function connectionHealthForLatency(latencyMs: number): ConnectionRuntime {
  return latencyMs >= 1_000
    ? { status: "slow", latencyMs, message: `SSH connected slowly (${latencyMs} ms)` }
    : { status: "online", latencyMs, message: `SSH connected (${latencyMs} ms)` };
}
