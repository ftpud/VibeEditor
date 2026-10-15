import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleInput } from "@remote-ide/protocol";
import { ScheduleService, validateSchedule } from "./schedules.js";

const directories: string[] = [];
const services: ScheduleService[] = [];
afterEach(async () => { vi.useRealTimers(); for (const service of services.splice(0)) await service.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const input = (extra: Partial<ScheduleInput> = {}): ScheduleInput => ({ name: "Daily check", dueAt: new Date(Date.now() + 60_000).toISOString(), taskId: "task-a", action: { type: "prompt", provider: "codex", prompt: "Check the build", agent: { scope: "local", name: "reviewer.md" } }, ...extra });
async function harness(deliver = vi.fn(async () => ({})), directory?: string) {
  const state = directory ?? await mkdtemp(path.join(os.tmpdir(), "vibe-schedules-"));
  if (!directory) directories.push(state);
  const changed = vi.fn();
  const service = new ScheduleService("/workspace", deliver, changed, state);
  services.push(service); await service.start();
  return { service, state, deliver, changed };
}
const stateFile = (state: string) => path.join(state, `${crypto.createHash("sha256").update("/workspace").digest("hex")}-schedules.json`);

describe("durable user schedules", () => {
  it("recovers a valid backup and rotates validated state through private atomic files", async () => {
    const seeded = await harness();
    const original = await seeded.service.create("root-a", input());
    await seeded.service.setEnabled(original.id, true);
    await seeded.service.close();
    const file = stateFile(seeded.state);
    const originalBytes = await readFile(file, "utf8");
    await writeFile(file, "{corrupt primary", "utf8");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const recovered = new ScheduleService("/workspace", vi.fn(async () => ({})), vi.fn(), seeded.state);
      services.push(recovered);
      await recovered.start();
      expect(recovered.list()).toEqual([original]);
      expect(await readFile(file, "utf8")).toBe("{corrupt primary");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("last-good backup"));

      await recovered.setEnabled(original.id, false);
      expect(JSON.parse(await readFile(file, "utf8")).schedules[0]).toMatchObject({ id: original.id, enabled: false });
      expect(JSON.parse(await readFile(`${file}.bak`, "utf8")).schedules).toEqual([original]);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
      expect((await readdir(seeded.state)).some((name) => name.endsWith(".tmp"))).toBe(false);
      expect(originalBytes).not.toBe("{corrupt primary");
    } finally { warning.mockRestore(); }
  });

  it("recovers from a backup when the primary is missing without restoring the primary on read", async () => {
    const seeded = await harness();
    const schedule = await seeded.service.create("root-a", input());
    await seeded.service.setEnabled(schedule.id, true);
    await seeded.service.close();
    const file = stateFile(seeded.state);
    await writeFile(`${file}.bak`, await readFile(file));
    await unlink(file);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const recovered = new ScheduleService("/workspace", vi.fn(async () => ({})), vi.fn(), seeded.state);
      services.push(recovered);
      await recovered.start();
      expect(recovered.list()).toEqual([schedule]);
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("primary is missing"));
    } finally { warning.mockRestore(); }
  });

  it("fails closed and preserves corrupt schedule bytes when no valid backup exists", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-schedule-corrupt-")); directories.push(state);
    const file = stateFile(state);
    const corrupt = "{\"schedules\":[null]}";
    await writeFile(file, corrupt, "utf8");
    const service = new ScheduleService("/workspace", vi.fn(async () => ({})), vi.fn(), state);
    services.push(service);
    await expect(service.start()).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(service.create("root-a", input())).rejects.toMatchObject({ code: "READ_FAILED" });
    expect(await readFile(file, "utf8")).toBe(corrupt);
    await expect(readFile(`${file}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(state)).some((name) => name.endsWith(".tmp"))).toBe(false);
    services.splice(services.indexOf(service), 1);
  });

  it("rejects malformed schedules before persisting them", async () => {
    const { service, state } = await harness();
    await expect(service.create(undefined as unknown as string, input())).rejects.toThrow();
    expect(service.list()).toEqual([]);
    expect((await readdir(state)).some((name) => name.endsWith(".tmp"))).toBe(false);
    services.splice(services.indexOf(service), 1);
  });

  it("recovers a one-time task/preset prompt and does not replay it after execution", async () => {
    const first = await harness();
    const schedule = await first.service.create("root-a", input());
    await first.service.close();
    const recovered = await harness(undefined, first.state);
    expect(recovered.service.list()).toEqual([schedule]);
    expect(await recovered.service.fire(schedule.id, true)).toBe(true);
    expect(recovered.deliver).toHaveBeenCalledWith(expect.objectContaining({ rootId: "root-a", taskId: "task-a", action: input().action }), expect.any(Function));
    await recovered.service.close();
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
    await service.close();
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
    await first.service.close();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(schedule.dueAt) + 5 * 60_000);
    const recovered = await harness(undefined, first.state);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recovered.deliver).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recovered.service.list()[0]!.enabled).toBe(true));
    expect(Date.parse(recovered.service.list()[0]!.dueAt)).toBeGreaterThan(Date.now());
    await recovered.service.close();
  });

  it("serializes concurrent creations and rejects invalid or past schedule times", async () => {
    const { service } = await harness();
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.create("root-a", input({ name: `Schedule ${i}` }))));
    expect(service.list()).toHaveLength(8);
    expect(() => validateSchedule(input({ intervalSeconds: 0 }))).toThrow("intervals");
    expect(() => validateSchedule(input({ dueAt: "invalid" }))).toThrow("time");
    await expect(service.create("root-a", input({ dueAt: new Date(Date.now() - 1000).toISOString() }))).rejects.toThrow("future");
  });

  it("preserves concurrent creations from separate service instances", async () => {
    const first = await harness();
    const second = await harness(undefined, first.state);
    await Promise.all([
      first.service.create("root-a", input({ name: "First instance" })),
      second.service.create("root-b", input({ name: "Second instance" }))
    ]);
    const recovered = await harness(undefined, first.state);
    expect(recovered.service.list().map((item) => item.name).sort()).toEqual(["First instance", "Second instance"]);
  });

  it("claims one automatic occurrence across instances loaded before the due time", async () => {
    const startAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(startAt);
    const deliver = vi.fn(async () => ({}));
    const first = await harness(deliver);
    const schedule = await first.service.create("root-a", input({ dueAt: new Date(startAt + 60_000).toISOString() }));
    const second = await harness(deliver, first.state);
    vi.setSystemTime(Date.parse(schedule.dueAt) + 1);

    const results = await Promise.all([first.service.fire(schedule.id), second.service.fire(schedule.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(deliver).toHaveBeenCalledOnce();
  });
});

it("drains an admitted schedule delivery and its final state before closing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { service, state } = await harness(vi.fn(async () => { entered(); await gate; return { workflowRunId: "drained-run" }; }));
  const schedule = await service.create("root-a", input());
  const firing = service.fire(schedule.id, true);
  try {
    await started;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    expect(await service.fire(schedule.id, true)).toBe(false);
    await expect(service.create("root-a", input())).rejects.toThrow("shutting down");
    await expect(service.setEnabled(schedule.id, true)).rejects.toThrow("shutting down");
    release();
    await firing; await closing;
    const restarted = await harness(undefined, state);
    expect(restarted.service.list()[0]).toMatchObject({ enabled: false, lastWorkflowRunId: "drained-run" });
  } finally { release(); await firing; }
});


it("stops automatic retries when damaged state prevents recording a launch failure", async () => {
  vi.useFakeTimers();
  const { service, state, deliver } = await harness();
  const schedule = await service.create("root-a", input());
  const file = stateFile(state);
  const previous = await readFile(file, "utf8");
  try {
    await writeFile(file, "{damaged primary");
    await writeFile(`${file}.bak`, "{damaged backup");
    await expect(service.fire(schedule.id, true)).rejects.toMatchObject({ code: "READ_FAILED" });
    expect(deliver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await readFile(file, "utf8")).toBe("{damaged primary");
    expect(await readFile(`${file}.bak`, "utf8")).toBe("{damaged backup");
  } finally {
    await writeFile(file, previous);
    await writeFile(`${file}.bak`, previous);
    await service.setEnabled(schedule.id, false);
  }
});
