import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerInput } from "@remote-ide/protocol";
import { TriggerService, validateTrigger, type TriggerDelivery, type TriggerEvent } from "./triggers.js";

const directories: string[] = [];
const services: TriggerService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const action: TriggerInput["action"] = { type: "prompt", provider: "codex", prompt: "React" };
async function harness(deliver = vi.fn(async (): Promise<TriggerDelivery> => ({}))) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-triggers-"));
  directories.push(dir);
  const service = new TriggerService("/workspace", deliver, vi.fn(), path.join(dir, "state"));
  services.push(service); await service.start();
  return { service, dir, deliver };
}
const events = (deliver: ReturnType<typeof vi.fn>) => deliver.mock.calls.map((call) => call[1] as TriggerEvent);

describe("reactive triggers", () => {
  it("validates sources, events and limits", () => {
    const base: TriggerInput = { name: "t", source: { type: "file", path: "/a", events: ["changed"] }, action };
    expect(() => validateTrigger(base)).not.toThrow();
    expect(() => validateTrigger({ ...base, source: { type: "file", path: "/a", events: [] } })).toThrow("file event");
    expect(() => validateTrigger({ ...base, source: { type: "fifo", path: "" } })).toThrow("path");
    expect(() => validateTrigger({ ...base, debounceSeconds: -1 })).toThrow("Quiet period");
    expect(() => validateTrigger({ ...base, maxFiresPerHour: 0 })).toThrow("Hourly limit");
    expect(() => validateTrigger({ ...base, action: { type: "prompt", provider: "codex", prompt: " " } })).toThrow("prompt");
    expect(() => validateTrigger({ ...base, action: { ...action, model: "m1", reasoning: "high" } })).not.toThrow();
    expect(() => validateTrigger({ ...base, action: { ...action, model: "" } })).toThrow("model");
  });

  it("fires when a watched file is created, changed and deleted", async () => {
    const { service, dir, deliver } = await harness();
    const target = path.join(dir, "watched.txt");
    const trigger = await service.create("root", { name: "watch", source: { type: "file", path: target, events: ["created", "changed", "deleted"] }, debounceSeconds: 0, action });
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the watcher record the file as absent before it appears
    await writeFile(target, "one");
    await vi.waitFor(() => expect(events(deliver).map((event) => event.description)).toEqual([`created: ${target}`]), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendFile(target, "two");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await unlink(target);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(events(deliver)[2]!.description).toBe(`deleted: ${target}`);
    await vi.waitFor(() => expect(service.list()[0]).toMatchObject({ id: trigger.id, fireCount: 3, lastEvent: `deleted: ${target}` }));
  });

  it("ignores file events that were not selected", async () => {
    const { service, dir, deliver } = await harness();
    const target = path.join(dir, "only-deleted.txt");
    await service.create("root", { name: "watch", source: { type: "file", path: target, events: ["deleted"] }, debounceSeconds: 0, action });
    await writeFile(target, "x");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(deliver).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("creates a named pipe and fires with the data written to it", async () => {
    const { service, dir, deliver } = await harness();
    const pipe = path.join(dir, "events.fifo");
    await service.create("root", { name: "pipe", source: { type: "fifo", path: pipe }, debounceSeconds: 0, action });
    expect((await stat(pipe)).isFIFO()).toBe(true);
    await writeFile(pipe, "build failed\n");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(events(deliver)[0]).toMatchObject({ data: "build failed\n" });
    await writeFile(pipe, "again\n");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });

  it.skipIf(process.platform === "win32")("refuses a pipe path that is a regular file", async () => {
    const { service, dir } = await harness();
    const file = path.join(dir, "plain");
    await writeFile(file, "x");
    await expect(service.create("root", { name: "pipe", source: { type: "fifo", path: file }, action })).rejects.toThrow("not a named pipe");
  });

  it("coalesces bursts into one run after the quiet period", async () => {
    const { service, dir, deliver } = await harness();
    const pipe = path.join(dir, "burst.fifo");
    await service.create("root", { name: "pipe", source: { type: "fifo", path: pipe }, debounceSeconds: 1, action });
    await writeFile(pipe, "a\n"); await writeFile(pipe, "b\n"); await writeFile(pipe, "c\n");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(events(deliver)[0]!.data).toBe("a\nb\nc\n");
  });

  it("records busy targets as skipped without disabling the trigger", async () => {
    const { service, dir } = await harness(vi.fn(async () => ({ skipped: "Target agent is busy" })));
    const pipe = path.join(dir, "busy.fifo");
    const trigger = await service.create("root", { name: "pipe", source: { type: "fifo", path: pipe }, debounceSeconds: 0, action });
    await writeFile(pipe, "x\n");
    await vi.waitFor(() => expect(service.list()[0]!.lastSkipped).toBe("Target agent is busy"), { timeout: 5000 });
    expect(service.list()[0]).toMatchObject({ id: trigger.id, enabled: true, fireCount: 0 });
  });

  it("disables a trigger that exceeds its hourly cap", async () => {
    const { service, dir, deliver } = await harness();
    const pipe = path.join(dir, "loop.fifo");
    await service.create("root", { name: "loop", source: { type: "fifo", path: pipe }, debounceSeconds: 0, maxFiresPerHour: 2, action });
    for (let index = 0; index < 3; index += 1) {
      await writeFile(pipe, `${index}\n`);
      await vi.waitFor(() => expect(service.list()[0]!.fireCount + (service.list()[0]!.enabled ? 0 : 1)).toBeGreaterThan(index), { timeout: 5000 });
    }
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(service.list()[0]).toMatchObject({ enabled: false, lastError: expect.stringContaining("feedback loop") });
  });

  it("persists triggers and manual fire ignores the quiet period", async () => {
    const first = await harness();
    const trigger = await first.service.create("root", { name: "persist", source: { type: "file", path: path.join(first.dir, "f"), events: ["changed"] }, action });
    expect(await first.service.fire(trigger.id)).toBe(true);
    expect(events(first.deliver)[0]!.description).toBe("manual run");
    await first.service.close();
    const second = new TriggerService("/workspace", vi.fn(async () => ({})), vi.fn(), path.join(first.dir, "state"));
    services.push(second); await second.start();
    expect(second.list()[0]).toMatchObject({ id: trigger.id, fireCount: 1, enabled: true });
    expect(await second.delete(trigger.id)).toBe(true);
    expect(second.list()).toEqual([]);
  });

  it("re-arms persisted triggers after Core restarts and fires on later changes", async () => {
    const first = await harness();
    const target = path.join(first.dir, "restart.txt");
    await first.service.create("root", { name: "restart", source: { type: "file", path: target, events: ["created"] }, debounceSeconds: 0, action });
    await first.service.close();
    const deliver = vi.fn(async (): Promise<TriggerDelivery> => ({}));
    const second = new TriggerService("/workspace", deliver, vi.fn(), path.join(first.dir, "state"));
    services.push(second); await second.start();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the watcher record the file as absent before it appears
    await writeFile(target, "after restart");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(second.list()[0]).toMatchObject({ enabled: true, fireCount: 1 }));
  });
});
