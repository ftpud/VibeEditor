import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleInput } from "@remote-ide/protocol";
import { ScheduleService, validateSchedule } from "./schedules.js";

const directories: string[] = [];
const services: ScheduleService[] = [];
afterEach(async () => { vi.useRealTimers(); for (const service of services.splice(0)) service.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const input = (extra: Partial<ScheduleInput> = {}): ScheduleInput => ({ name: "Daily check", dueAt: new Date(Date.now() + 60_000).toISOString(), taskId: "task-a", action: { type: "prompt", provider: "codex", prompt: "Check the build", agent: { scope: "local", name: "reviewer.md" } }, ...extra });
async function harness(deliver = vi.fn(async () => ({})), directory?: string) {
  const state = directory ?? await mkdtemp(path.join(os.tmpdir(), "vibe-schedules-"));
  if (!directory) directories.push(state);
  const changed = vi.fn();
  const service = new ScheduleService("/workspace", deliver, changed, state);
  services.push(service); await service.start();
  return { service, state, deliver, changed };
}

describe("durable user schedules", () => {
  it("recovers a one-time task/preset prompt and does not replay it after execution", async () => {
    const first = await harness();
    const schedule = await first.service.create("root-a", input());
    first.service.close();
    const recovered = await harness(undefined, first.state);
    expect(recovered.service.list()).toEqual([schedule]);
    expect(await recovered.service.fire(schedule.id, true)).toBe(true);
    expect(recovered.deliver).toHaveBeenCalledWith(expect.objectContaining({ rootId: "root-a", taskId: "task-a", action: input().action }), expect.any(Function));
    recovered.service.close();
    const restarted = await harness(undefined, first.state);
    expect(restarted.service.list()[0]).toMatchObject({ enabled: false, lastRunAt: expect.any(String) });
    expect(await restarted.service.fire(schedule.id)).toBe(false);
    expect(restarted.deliver).not.toHaveBeenCalled();
  });

  it("keeps recurring workflows enabled, records the run, and persists pause/delete", async () => {
    const { service, state, deliver } = await harness(vi.fn(async () => ({ workflowRunId: "run-1" })));
    const schedule = await service.create("root-a", input({ intervalSeconds: 3600, action: { type: "workflow", provider: "codex", harnessId: "workflow-a", input: "Check release" } }));
    expect(await service.fire(schedule.id, true)).toBe(true);
    expect(service.list()[0]).toMatchObject({ enabled: true, lastWorkflowRunId: "run-1" });
    expect(Date.parse(service.list()[0]!.dueAt)).toBeGreaterThan(Date.now() + 3_500_000);
    await service.setEnabled(schedule.id, false);
    expect(await service.fire(schedule.id)).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
    service.close();
    const recovered = await harness(undefined, state);
    expect(recovered.service.list()[0]!.enabled).toBe(false);
    await recovered.service.delete(schedule.id);
    expect(recovered.service.list()).toEqual([]);
    expect(await recovered.service.fire(schedule.id, true)).toBe(false);
  });

  it("pauses a failed launch and reports the failure rather than retrying repeatedly", async () => {
    const { service } = await harness(vi.fn(async () => { throw new Error("Target agent is busy"); }));
    const schedule = await service.create("root-a", input({ intervalSeconds: 60 }));
    expect(await service.fire(schedule.id, true)).toBe(false);
    expect(service.list()[0]).toMatchObject({ enabled: false, lastError: "Target agent is busy" });
    await service.setEnabled(schedule.id, true);
    expect(service.list()[0]).toMatchObject({ enabled: true, lastError: undefined });
  });

  it("prevents overlapping runs and lets deletion invalidate a launch waiting for its target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent = vi.fn();
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-schedule-race-")); directories.push(state);
    const service = new ScheduleService("/workspace", async (_, active) => { await gate; if (active()) sent(); return {}; }, vi.fn(), state);
    services.push(service); await service.start();
    const schedule = await service.create("root-a", input({ intervalSeconds: 60 }));
    const firing = service.fire(schedule.id, true);
    await vi.waitFor(() => expect(service.list()[0]!.lastRunAt).toBeTruthy());
    expect(await service.fire(schedule.id, true)).toBe(false);
    await service.delete(schedule.id); release(); await firing;
    expect(sent).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
  });

  it("executes overdue recurring schedules once after restart and advances the next run", async () => {
    const first = await harness();
    const schedule = await first.service.create("root-a", input({ intervalSeconds: 60 }));
    first.service.close();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(schedule.dueAt) + 5 * 60_000);
    const recovered = await harness(undefined, first.state);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recovered.deliver).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recovered.service.list()[0]!.enabled).toBe(true));
    expect(Date.parse(recovered.service.list()[0]!.dueAt)).toBeGreaterThan(Date.now());
    recovered.service.close();
  });

  it("serializes concurrent creations and rejects invalid or past schedule times", async () => {
    const { service } = await harness();
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.create("root-a", input({ name: `Schedule ${i}` }))));
    expect(service.list()).toHaveLength(8);
    expect(() => validateSchedule(input({ intervalSeconds: 0 }))).toThrow("intervals");
    expect(() => validateSchedule(input({ dueAt: "invalid" }))).toThrow("time");
    await expect(service.create("root-a", input({ dueAt: new Date(Date.now() - 1000).toISOString() }))).rejects.toThrow("future");
  });
});
