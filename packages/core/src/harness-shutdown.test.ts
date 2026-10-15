import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { HarnessRunner } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";

it("preserves an interrupted workflow journal and pauses ambiguous recovery without replaying its prompt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-shutdown-"));
  const store = new HarnessStore(directory, path.join(directory, "state"));
  const runner = new HarnessRunner(store, () => {});
  const recovered = new HarnessRunner(store, () => {});
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const session: AiSession = { id: "interrupted-session", model: "auto", reasoning: "medium", status: "idle", messages: [] };
  try {
    const created = await store.create("Shutdown");
    const definition = await store.update({ ...created, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "{{input}}", position: { x: 0, y: 0 } }], edges: [] });
    const dispatch = vi.fn<Parameters<HarnessRunner["start"]>[2]>(async (_block, _prompt, context) => {
      await context.started(directory);
      await context.activity({ ...session, status: "in_progress" });
      await waiting;
      return { ...session, status: "done" as const };
    });
    const run = await runner.start(definition.id, "preserve work", dispatch);
    await vi.waitFor(async () => expect((await store.runs())[0]?.blocks[0]?.sessionId).toBe(session.id));
    await runner.suspend();
    const snapshot = (await store.runs())[0]!;
    expect(snapshot.status).toBe("running");
    expect(snapshot.operations?.some((operation) => operation.status === "intent")).toBe(true);
    expect(runner.isActive(run.id)).toBe(false);
    await expect(runner.start(definition.id, "new work", dispatch)).rejects.toThrow("shutting down");
    release();
    await runner.drain();
    expect((await store.runs())[0]).toEqual(snapshot);
    const replay = vi.fn();
    const runs = await recovered.recover(replay, "codex", undefined, { session: async () => session, timer: async () => false });
    expect(runs[0]?.blocks[0]).toMatchObject({ status: "retry_scheduled", failureReason: "recovery_orphaned" });
    expect(replay).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([runner.suspend(), recovered.suspend()]);
    await Promise.all([runner.drain(), recovered.drain()]);
    await rm(directory, { recursive: true, force: true });
  }
});
