import { expect, it, vi } from "vitest";
import type { ServerEvent } from "@remote-ide/protocol";
import { InvalidationRefreshes, type InvalidationScope } from "./invalidation-refreshes";
import { CoalescedAsyncAction } from "./client";

const configuration: ServerEvent = { type: "configuration.changed", payload: { rootId: "root-a", resource: "agents", global: false } };
const processes: ServerEvent = { type: "processes.changed", payload: {} };
function fixture() {
  let scope: InvalidationScope | undefined = { rootId: "root-a", workspace: "/a", revision: 0 };
  const pending: Array<{ type: string; resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const request = vi.fn((type: string) => new Promise<string>((resolve, reject) => { pending.push({ type, resolve, reject }); }));
  const visible: Record<string, string> = {};
  const read = async (type: string, canApply: () => boolean) => { const result = await request(type); if (canApply()) visible[type] = result; };
  const failed = vi.fn();
  const actions = {
    configuration: [
      async (canApply: () => boolean) => { await read("skills.list", canApply); if (canApply()) await read("agents.list", canApply); },
      (canApply: () => boolean) => read("useful.list", canApply),
      (canApply: () => boolean) => read("harnesses.list", canApply),
      (canApply: () => boolean) => read("tasks.list", canApply)
    ],
    processes: (canApply: () => boolean) => read("processes.list", canApply),
    configurationFailed: failed
  };
  const refreshes = new InvalidationRefreshes(() => scope, actions);
  const complete = (value: string) => { for (const item of pending.splice(0)) item.resolve(value); };
  const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const batch = async (value: string) => { complete(value); await tick(); complete(value); await tick(); };
  return { refreshes, request, pending, visible, failed, complete, tick, batch, setScope: (next: InvalidationScope | undefined) => { scope = next; }, actions };
}

it("reduces 100 invalidation pairs to two five-read configuration batches and two process reads", async () => {
  const f = fixture(); f.refreshes.handle(configuration); f.refreshes.handle(processes);
  for (let i = 0; i < 100; i++) { f.refreshes.handle(configuration); f.refreshes.handle(processes); }
  expect(f.request).toHaveBeenCalledTimes(5); // Four configuration entry reads plus processes.
  f.complete("old"); await f.tick(); // agents follows skills; process follow-up can start independently.
  expect(f.request).toHaveBeenCalledTimes(7);
  f.complete("new"); await f.tick(); // Completing agents releases the configuration batch.
  expect(f.request).toHaveBeenCalledTimes(11);
  await f.batch("latest"); await f.refreshes.whenIdle();
  expect(f.request).toHaveBeenCalledTimes(12);
  expect(f.request.mock.calls.filter(([type]) => type === "processes.list")).toHaveLength(2);
  expect(f.visible).toEqual({ "skills.list": "latest", "agents.list": "latest", "useful.list": "latest", "harnesses.list": "latest", "tasks.list": "latest", "processes.list": "new" });
});

it("retains an event arriving during the follow-up and does not overlap failed batches", async () => {
  const f = fixture(); f.refreshes.handle(configuration); f.refreshes.handle(configuration);
  f.pending.find((item) => item.type === "useful.list")!.reject(new Error("failure"));
  await f.tick(); expect(f.request).toHaveBeenCalledTimes(4); expect(f.failed).not.toHaveBeenCalled();
  // Failure cannot finish a batch while its siblings remain active.
  await f.batch("first"); expect(f.failed).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledTimes(9);
  f.refreshes.handle(configuration); // Retain one further batch while the first follow-up runs.
  await f.batch("second"); expect(f.request).toHaveBeenCalledTimes(14);
  await f.batch("final"); await f.refreshes.whenIdle(); expect(f.request).toHaveBeenCalledTimes(15);
  expect(f.visible["useful.list"]).toBe("final");
  f.refreshes.handle(configuration); await f.batch("after failure"); await f.refreshes.whenIdle();
  expect(f.visible["agents.list"]).toBe("after failure");
});

it("accepts global configuration hints, filters foreign local roots, and leaves ordered streams alone", async () => {
  const f = fixture();
  f.refreshes.handle({ ...configuration, payload: { ...configuration.payload, rootId: "other" } });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.refreshes.handle({ type: "terminal.output", payload: { rootId: "root-a", terminalId: "t", data: "ordered" } })).toBe(false);
  expect(f.refreshes.handle({ type: "ai.changed", payload: { rootId: "root-a" } })).toBe(false);
  f.refreshes.handle({ ...configuration, payload: { ...configuration.payload, rootId: "other", global: true } });
  await f.batch("global"); await f.refreshes.whenIdle(); expect(f.request).toHaveBeenCalledTimes(5);
});

it.each(["root", "task", "disconnect", "replacement", "unmount"])("discards queued work and obsolete commits after %s", async (change) => {
  const f = fixture(); f.refreshes.handle(configuration); f.refreshes.handle(configuration);
  f.refreshes.handle(processes); f.refreshes.handle(processes);
  if (change === "root") {
    f.setScope({ rootId: "root-b", workspace: "/b", revision: 0 });
    f.refreshes.refreshConfiguration();
  } else if (change === "task") {
    f.refreshes.reset(); f.setScope({ rootId: "root-a", workspace: "/task", revision: 1 });
    f.refreshes.refreshConfiguration();
  } else if (change === "disconnect") { f.refreshes.reset(); f.setScope(undefined); }
  else { f.refreshes.dispose(); }
  const old = f.pending.splice(0, 5);
  for (const [index, item] of old.entries()) {
    if (change === "replacement" && index === 1) item.reject(new Error("obsolete configuration error"));
    else item.resolve("obsolete");
  }
  await f.tick(); expect(f.failed).not.toHaveBeenCalled();
  expect(Object.values(f.visible)).not.toContain("obsolete");
  expect(f.request.mock.calls.filter(([type]) => type === "agents.list")).toHaveLength(0);
  if (change === "root" || change === "task") {
    await f.batch("current"); await f.refreshes.whenIdle(); expect(f.visible["agents.list"]).toBe("current");
    expect(f.request).toHaveBeenCalledTimes(10); // old five + new five; old follow-up discarded.
  } else {
    expect(f.request).toHaveBeenCalledTimes(5);
    if (change === "disconnect") {
      // Same CoreClient can reconnect to the same root: disposed epochs must never revive.
      f.setScope({ rootId: "root-a", workspace: "/a", revision: 0 });
      f.refreshes.handle(configuration); await f.batch("recovered"); await f.refreshes.whenIdle();
      expect(f.visible["agents.list"]).toBe("recovered");
    } else { f.refreshes.handle(configuration); expect(f.request).toHaveBeenCalledTimes(5); }
  }
});

it("disposal permanently disables queued callbacks and their commit guards", async () => {
  let release!: () => void; let canApply!: () => boolean;
  const action = vi.fn(async (guard: () => boolean) => { canApply = guard; await new Promise<void>((resolve) => { release = resolve; }); });
  const coalesced = new CoalescedAsyncAction(action);
  coalesced.trigger(); coalesced.trigger(); expect(canApply()).toBe(true);
  coalesced.dispose(); expect(canApply()).toBe(false); coalesced.trigger();
  release(); await coalesced.whenIdle(); expect(action).toHaveBeenCalledOnce();
});

it("accepts a process event after a failed read and retains the event during its retry", async () => {
  const f = fixture(); f.refreshes.handle(processes);
  f.pending.shift()!.reject(new Error("unavailable")); await f.tick();
  f.refreshes.handle(processes); f.refreshes.handle(processes);
  expect(f.request).toHaveBeenCalledTimes(2);
  f.complete("intermediate"); await f.tick(); expect(f.request).toHaveBeenCalledTimes(3);
  f.complete("final processes"); await f.refreshes.whenIdle();
  expect(f.visible["processes.list"]).toBe("final processes");
});
