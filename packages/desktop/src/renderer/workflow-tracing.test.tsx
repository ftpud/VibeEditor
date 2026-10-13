import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessRun } from "@remote-ide/protocol";
import { useWorkflowTraces } from "./workflow-tracing";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function finishedRun(timestamp: string): HarnessRun {
  return { id: "fast-run", harnessId: "flow", harnessVersion: 1, input: "start", status: "succeeded", createdAt: timestamp, blocks: [], connectionTraces: [
    { id: "request", edgeId: "edge", direction: "forward", status: "succeeded", startedAt: timestamp, completedAt: timestamp },
    { id: "reply", edgeId: "edge", direction: "return", status: "succeeded", startedAt: timestamp, completedAt: timestamp }
  ] };
}

describe("workflow transfer animation", () => {
  it("shows fast transfers even when the first snapshot is already completed", () => {
    vi.useFakeTimers();
    const run = finishedRun(new Date().toISOString());
    const { result, rerender } = renderHook(({ run }) => useWorkflowTraces(run), { initialProps: { run } });
    expect(result.current.map((trace) => trace.id)).toEqual(["request", "reply"]);
    expect(result.current[1]?.delayMs).toBe(900);
    act(() => { vi.advanceTimersByTime(2500); });
    expect(result.current).toEqual([]);
    rerender({ run: structuredClone(run) });
    expect(result.current).toEqual([]);
  });

  it("keeps historical transfers quiet and clears transfers on cancellation", () => {
    vi.useFakeTimers();
    const old = finishedRun(new Date(Date.now() - 60_000).toISOString());
    const { result, rerender } = renderHook(({ run }) => useWorkflowTraces(run), { initialProps: { run: old } });
    expect(result.current).toEqual([]);
    const fresh = { ...finishedRun(new Date().toISOString()), id: "new-run" };
    rerender({ run: fresh });
    expect(result.current).toHaveLength(2);
    rerender({ run: { ...fresh, status: "cancelled" } });
    expect(result.current).toEqual([]);
  });
});
