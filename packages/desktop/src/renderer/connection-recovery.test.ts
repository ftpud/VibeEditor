import { afterEach, expect, it, vi } from "vitest";
import { ConnectionRecovery } from "./connection-recovery";

afterEach(() => vi.useRealTimers());

it("owns one recovery loop through repeated notifications and failed restoration", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const attempt = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const failed = vi.fn();
  const recovery = new ConnectionRecovery(attempt, failed, 10, 20);
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
  const recovery = new ConnectionRecovery(attempt, vi.fn(), 10, 20);
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
  const recovery = new ConnectionRecovery(attempt, failed, 10, 20);
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
