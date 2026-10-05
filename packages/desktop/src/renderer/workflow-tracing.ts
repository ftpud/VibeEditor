import { useEffect, useRef, useState } from "react";
import type { HarnessConnectionTrace, HarnessRun } from "@remote-ide/protocol";

export type AnimatedWorkflowTrace = HarnessConnectionTrace & { receivedAt: number; delayMs: number };
const durationMs = 900;
const activeStatuses = new Set(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);

export function useWorkflowTraces(run?: HarnessRun): AnimatedWorkflowTrace[] {
  const [traces, setTraces] = useState<AnimatedWorkflowTrace[]>([]);
  const cursor = useRef<{ runId?: string; seen: Set<string> }>({ seen: new Set() });
  const active = Boolean(run && activeStatuses.has(run.status));
  useEffect(() => {
    const records = run?.connectionTraces ?? [];
    const now = Date.now();
    if (cursor.current.runId !== run?.id) {
      cursor.current = { runId: run?.id, seen: new Set(records.map((trace) => trace.id)) };
      setTraces(active ? records.filter((trace) => trace.status === "active").map((trace) => ({ ...trace, receivedAt: now, delayMs: 0 })) : []);
      return;
    }
    if (run?.status === "cancelled") { setTraces([]); return; }
    const additions = records.filter((trace) => !cursor.current.seen.has(trace.id));
    cursor.current.seen = new Set(records.map((trace) => trace.id));
    setTraces((previous) => {
      const next = previous.map((trace) => ({ ...trace, ...records.find((record) => record.id === trace.id) }));
      for (const trace of additions) {
        const request = trace.direction === "return" ? [...next].reverse().find((item) => item.edgeId === trace.edgeId && item.direction === "forward") : undefined;
        const delayMs = request ? Math.max(0, durationMs - (now - request.receivedAt)) : 0;
        next.push({ ...trace, receivedAt: now, delayMs });
      }
      return next.filter((trace) => (active && trace.status === "active") || now - trace.receivedAt < durationMs + trace.delayMs + 300).slice(-64);
    });
  }, [run?.id, run?.connectionTraces, run?.status, active]);
  useEffect(() => {
    if (!traces.length) return;
    const timer = window.setTimeout(() => {
      setTraces((current) => current.filter((trace) => (active && trace.status === "active") || Date.now() - trace.receivedAt < durationMs + trace.delayMs + 300));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [traces, active]);
  return traces;
}
