import { afterEach, expect, it, vi } from "vitest";
import { ConnectionRecovery, recoveryFailureFeedback, recoveryRetryDelay } from "./connection-recovery";

afterEach(() => vi.useRealTimers());

it("owns one recovery loop through repeated notifications and failed restoration", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const attempt = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const failed = vi.fn();
  const recovery = new ConnectionRecovery(attempt, failed, 10, 20, () => 1);
  recovery.start(); recovery.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledOnce();
  recovery.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(attempt).toHaveBeenCalledTimes(2);
  recovery.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(attempt).toHaveBeenCalledTimes(2);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  recovery.stop();
});

it("cancels retry timers and does not resume after shutdown", async () => {
  vi.useFakeTimers();
  const attempt = vi.fn().mockRejectedValue(new Error("unavailable"));
  const recovery = new ConnectionRecovery(attempt, vi.fn(), 10, 20, () => 1);
  recovery.start();
  await vi.advanceTimersByTimeAsync(10);
  recovery.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(attempt).toHaveBeenCalledOnce();
});

it("aborts active restoration without spawning another attempt", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  let signal!: AbortSignal;
  const attempt = vi.fn((value: AbortSignal) => { signal = value; return new Promise<void>((_resolve, fail) => { reject = fail; }); });
  const failed = vi.fn();
  const recovery = new ConnectionRecovery(attempt, failed, 10, 20, () => 1);
  recovery.start(); await vi.advanceTimersByTimeAsync(10);
  recovery.stop();
  expect(signal.aborted).toBe(true);
  reject(new Error("cancelled"));
  await vi.advanceTimersByTimeAsync(100);
  expect(failed).not.toHaveBeenCalled();
  expect(attempt).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("fails restoration explicitly for unavailable saved workspace/task selections", async () => {
  const { reconnectWorkspace } = await import("./connection-recovery");
  for (const mismatch of ["workspace", "task"]) {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation(async (type: string) => {
        if (type === "workspace.roots") return { selectedRootId: "root-a", roots: [] };
        if (type === "workspace.open") return { workspace: mismatch === "workspace" ? "/root" : "/task-a" };
        if (type === "tasks.list") return { tasks: [], selectedTaskId: undefined };
      })
    } as unknown as import("./client").CoreClient;
    await expect(reconnectWorkspace(client, "host", 7331, false, new AbortController().signal, { rootId: "root-a", workspace: "/task-a", taskId: "task-a" })).rejects.toThrow(mismatch === "workspace" ? "Saved workspace is unavailable" : "Saved task selection is unavailable");
  }
});

it("bounds equal jitter with a nonzero minimum and validates timer configuration", () => {
  for (const backoff of [1, 250, 500, 1000, 2000, 4000, 5000]) {
    for (const sample of [0, 0.2, 0.5, 0.99, 1, -1, 2, NaN, Infinity]) {
      const delay = recoveryRetryDelay(backoff, sample);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(Math.ceil(backoff / 2));
      expect(delay).toBeLessThanOrEqual(backoff);
    }
  }
  expect(recoveryRetryDelay(250, 0)).toBe(125);
  expect(recoveryRetryDelay(5000, 1)).toBe(5000);
  for (const initial of [0, -1, 1.2, NaN, Infinity, 2_147_483_648]) expect(() => new ConnectionRecovery(vi.fn(), vi.fn(), initial)).toThrow();
  expect(() => new ConnectionRecovery(vi.fn(), vi.fn(), 300, 200)).toThrow();
  expect(() => new ConnectionRecovery(vi.fn(), vi.fn(), 10, 0)).toThrow();
});

it("spreads peers, doubles the independent backoff window, caps it, and resets after success", async () => {
  vi.useFakeTimers();
  const lower = vi.fn().mockRejectedValue(new Error("offline"));
  const upper = vi.fn().mockRejectedValue(new Error("offline"));
  const early = new ConnectionRecovery(lower, vi.fn(), 250, 5000, () => 0);
  const late = new ConnectionRecovery(upper, vi.fn(), 250, 5000, () => 1);
  early.start(); late.start();
  await vi.advanceTimersByTimeAsync(124); expect(lower).not.toHaveBeenCalled(); expect(upper).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(lower).toHaveBeenCalledOnce(); expect(upper).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(125); expect(upper).toHaveBeenCalledOnce();
  expect(lower).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(124); expect(lower).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(lower).toHaveBeenCalledTimes(2);
  early.stop(); late.stop(); expect(vi.getTimerCount()).toBe(0);

  const times: number[] = []; const start = Date.now();
  const attempt = vi.fn(async () => { times.push(Date.now() - start); if (times.length < 8) throw new Error("offline"); });
  const random = vi.fn(() => 1);
  const recovery = new ConnectionRecovery(attempt, vi.fn(), 250, 5000, random);
  recovery.start();
  const windows = [250, 500, 1000, 2000, 4000, 5000, 5000, 5000];
  let expected = 0;
  for (const window of windows) {
    const before = times.length;
    await vi.advanceTimersByTimeAsync(window - 1);
    expect(times).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1); expected += window;
    expect(times).toHaveLength(before + 1); expect(times.at(-1)).toBe(expected);
  }
  expect(vi.getTimerCount()).toBe(0); expect(random).toHaveBeenCalledTimes(8);
  recovery.start(); await vi.advanceTimersByTimeAsync(249); expect(attempt).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(1); expect(attempt).toHaveBeenCalledTimes(9);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let a replaced in-progress attempt schedule retries or clear the new loop", async () => {
  vi.useFakeTimers();
  let rejectOld!: (error: Error) => void;
  const signals: AbortSignal[] = [];
  const attempt = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<void>((_resolve, reject) => { if (signals.length === 1) rejectOld = reject; }); });
  const failed = vi.fn(); const recovery = new ConnectionRecovery(attempt, failed, 250, 5000, () => 0);
  recovery.start(); await vi.advanceTimersByTimeAsync(125);
  recovery.stop(); recovery.start();
  expect(signals[0]!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(1);
  rejectOld(new Error("obsolete")); await vi.advanceTimersByTimeAsync(0);
  recovery.start(); expect(vi.getTimerCount()).toBe(1); expect(failed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(125); expect(attempt).toHaveBeenCalledTimes(2);
  expect(signals[1]!.aborted).toBe(false);
  recovery.stop(); expect(signals[1]!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("reports snapshot producer rejection once and stops retrying", async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error("Narrow the workspace"), { code: "WORKSPACE_TREE_TOO_LARGE" });
  const attempt = vi.fn().mockRejectedValue(error);
  const failed = vi.fn();
  const recovery = new ConnectionRecovery(attempt, failed, 10, 20, () => 1);
  recovery.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(attempt).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledWith(error);
  expect(vi.getTimerCount()).toBe(0);
});


it("shows actionable paused feedback for snapshot limits and progress for transient failures", () => {
  const feedback = recoveryFailureFeedback(Object.assign(new Error("Tree exceeds maxNodes (10000)"), { code: "WORKSPACE_TREE_TOO_LARGE" }));
  expect(feedback).toMatchObject({ retry: false, kind: "error" });
  expect(feedback.message).toContain("Tree exceeds maxNodes");
  expect(feedback.message).toContain("restoration paused");
  expect(feedback.message).toContain("reconnect or select a workspace");
  expect(feedback.message).not.toContain("retrying");
  expect(recoveryFailureFeedback(new Error("Offline"))).toEqual({ retry: true, kind: "progress", message: "Offline; retrying…" });
});
