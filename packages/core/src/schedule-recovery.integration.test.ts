import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ScheduleService } from "./schedules.js";

it("preserves an interrupted launch as an explicit unknown outcome after SIGKILL instead of replaying it", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "schedule-launch-crash-"));
  const module = new URL("./schedules.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { ScheduleService } from ${JSON.stringify(module)};
    const keepAlive = setInterval(() => {}, 1000);
    const service = new ScheduleService('/workspace', async () => {
      process.stdout.write('LAUNCH_STARTED\\n');
      await new Promise(() => {});
      return {};
    }, () => {}, process.argv[1]);
    await service.start();
    const schedule = await service.create('root', {
      name:'Interrupted launch',dueAt:new Date(Date.now()+60000).toISOString(),
      action:{type:'prompt',provider:'provider',prompt:'Check once'}
    });
    await service.fire(schedule.id, true);
    clearInterval(keepAlive);
  `, state], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let service: ScheduleService | undefined;
  try {
    await vi.waitFor(() => expect(output, output).toContain("LAUNCH_STARTED"), { timeout: 8_000 });
    // Another live Core must not repeat an already-owned manual launch either.
    const liveDeliver = vi.fn(async () => ({}));
    const livePeer = new ScheduleService("/workspace", liveDeliver, () => {}, state);
    try {
      await livePeer.start();
      const schedule = livePeer.list()[0]!;
      expect(schedule).not.toHaveProperty("pendingLaunch");
      expect(await livePeer.fire(schedule.id, true)).toBe(false);
      expect(liveDeliver).not.toHaveBeenCalled();
    } finally { await livePeer.close(); }
    child.kill("SIGKILL"); await exited;
    const deliver = vi.fn(async () => ({}));
    service = new ScheduleService("/workspace", deliver, () => {}, state);
    await service.start();
    const recovered = service.list()[0]!;
    expect(recovered).toMatchObject({ enabled: false, lastError: expect.stringContaining("stopped while this schedule was launching") });
    expect(recovered).not.toHaveProperty("pendingLaunch");
    expect(deliver).not.toHaveBeenCalled();
    expect(await service.fire(recovered.id)).toBe(false);
    // Retry is a deliberate user action after inspecting preserved work.
    expect(await service.fire(recovered.id, true)).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(service.list()[0]?.lastError).toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await service?.close();
    await rm(state, { recursive: true, force: true });
  }
}, 15_000);
