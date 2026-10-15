import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AiTimerService, AiTimerStore, type AiContinuationTimer } from "./ai-timers.js";

function timerFile(root: string, state: string): string {
  return path.join(state, `${createHash("sha256").update(root).digest("hex")}-ai-timers.json`);
}

function validTimer(overrides: Partial<AiContinuationTimer> = {}): AiContinuationTimer {
  return { id: "timer-1", workspace: "/task", provider: "codex", prompt: "", createdAt: new Date().toISOString(), dueAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
}

describe("AI continuation timers", () => {
  it("supports an absent file and a valid legacy empty timer list", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-empty-timer-store-"));
    const store = new AiTimerStore("/workspace", state);
    try {
      await expect(store.list()).resolves.toEqual([]);
      await writeFile(timerFile("/workspace", state), JSON.stringify({ timers: [] }));
      await expect(store.list()).resolves.toEqual([]);
    } finally { await rm(state, { recursive: true, force: true }); }
  });

  it.each([
    ["non-array timer collection", JSON.stringify({ timers: { id: "timer-1" } })],
    ["empty timer identity", JSON.stringify({ timers: [validTimer({ id: "" })] })],
    ["duplicate timer identity", JSON.stringify({ timers: [validTimer(), validTimer()] })],
    ["invalid timer record", JSON.stringify({ timers: [validTimer(), { id: "timer-2" }] })],
    ["invalid optional workflow field", JSON.stringify({ timers: [validTimer({ workflowRunId: 42 as unknown as string })] })],
    ["malformed due date", JSON.stringify({ timers: [validTimer({ dueAt: "not-a-date" })] })],
    ["malformed creation date", JSON.stringify({ timers: [validTimer({ createdAt: "not-a-date" })] })],
  ])("fails closed on %s without changing the original during list or mutation", async (_label, contents) => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-invalid-timer-store-"));
    const file = timerFile("/workspace", state);
    const store = new AiTimerStore("/workspace", state);
    await writeFile(file, contents);
    try {
      await expect(store.list()).rejects.toMatchObject({ code: "READ_FAILED" });
      await expect(store.set("/new-task", "codex", "continue", 60)).rejects.toMatchObject({ code: "READ_FAILED" });
      await expect(store.remove("timer-1")).rejects.toMatchObject({ code: "READ_FAILED" });
      expect(await readFile(file, "utf8")).toBe(contents);
      expect((await readdir(state)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { await rm(state, { recursive: true, force: true }); }
  });

  it("recovers a valid backup and saves the validated previous state as the next backup", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-backup-recovery-"));
    const file = timerFile("/workspace", state);
    const backup = `${file}.bak`;
    const previous = validTimer({ id: "last-good", prompt: "" });
    const corruptPrimary = "{broken primary";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new AiTimerStore("/workspace", state);
    try {
      await writeFile(file, corruptPrimary);
      await writeFile(backup, `${JSON.stringify({ timers: [previous] })}\n`);
      await expect(store.list()).resolves.toEqual([previous]);
      expect(await readFile(file, "utf8")).toBe(corruptPrimary);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("last-good backup"));

      const next = await store.set("/new-task", "codex", "continue", 60);
      await expect(store.list()).resolves.toEqual([previous, next]);
      await expect(readFile(backup, "utf8").then(JSON.parse)).resolves.toEqual({ timers: [previous] });
      await expect(readFile(file, "utf8").then(JSON.parse)).resolves.toEqual({ timers: [previous, next] });
      for (const pathName of [file, backup]) expect((await stat(pathName)).mode & 0o777).toBe(0o600);
      expect((await readdir(state)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      warning.mockRestore();
      await rm(state, { recursive: true, force: true });
    }
  });

  it("reads a valid backup when the primary is missing without restoring the primary", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-missing-timer-primary-"));
    const file = timerFile("/workspace", state);
    const backup = `${file}.bak`;
    const previous = validTimer({ id: "backup-only" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new AiTimerStore("/workspace", state);
    try {
      await writeFile(backup, JSON.stringify({ timers: [previous] }));
      await expect(store.list()).resolves.toEqual([previous]);
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      await rm(state, { recursive: true, force: true });
    }
  });

  it("suspends delivery handles while retaining durable timers for restart", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-suspend-"));
    const store = new AiTimerStore("/workspace", state);
    const provider = { get: vi.fn(async () => ({ status: "done", messages: [] })), send: vi.fn(), steer: vi.fn() };
    const service = new AiTimerService(store, { get: () => provider } as never, "/workspace", vi.fn());
    const timer = await service.schedule("/task", "codex", "Survive restart", 60);
    await service.suspend();
    await service.fireById(timer.id);
    expect(provider.send).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([timer]);
    await service.cancelAll();
  });

  it("does not send a continuation if Stop races provider session lookup", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-cancel-race-"));
    const store = new AiTimerStore("/workspace", state);
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const provider = { get: vi.fn(async () => { await waiting; return { status: "done", model: "test", messages: [] }; }), send: vi.fn(), steer: vi.fn() };
    const service = new AiTimerService(store, { get: () => provider } as never, "/workspace", vi.fn());
    await service.schedule("/task", "codex", "continue", 60);
    const firing = service.fireNext("/task");
    try {
      await vi.waitFor(() => expect(provider.get).toHaveBeenCalled());
      await service.cancelWorkspace("/task");
    } finally { release(); }
    await firing;
    expect(provider.send).not.toHaveBeenCalled();
    expect(provider.steer).not.toHaveBeenCalled();
  });
  it("lists hidden sessions and controls the exact timer without cancelling another provider", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-ids-"));
    const store = new AiTimerStore("/workspace", state);
    const provider = { get: vi.fn(async () => ({ status: "done", model: "test", messages: [] })), send: vi.fn(), steer: vi.fn() };
    const service = new AiTimerService(store, { get: () => provider } as never, "/workspace", vi.fn());
    const first = await service.schedule("/hidden/workflow", "codex", "First", 60);
    const second = await service.schedule("/hidden/workflow", "copilot", "Second", 90);
    try {
      expect(await service.list()).toEqual([first, second]);
      expect(await service.cancel(second.id)).toBe(true);
      expect(await service.list()).toEqual([first]);
      expect(await service.fireById(first.id)).toBe(true);
      expect(provider.send).toHaveBeenCalledWith("/hidden/workflow", expect.objectContaining({ prompt: "First" }));
      expect(await service.list()).toEqual([]);
      expect(await service.fireById(first.id)).toBe(false);
    } finally { await service.cancelAll(); }
  });

  it("cancels a stopped provider's timers while retaining another provider's schedule", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-provider-stop-"));
    const service = new AiTimerService(new AiTimerStore("/workspace", state), {} as never, "/workspace", vi.fn());
    await service.schedule("/task", "codex", "Stopped", 60);
    const other = await service.schedule("/task", "copilot", "Keep", 60);
    try {
      await service.cancelProvider("/task", "codex");
      expect(await service.list()).toEqual([other]);
    } finally { await service.cancelAll(); }
  });

  it("cancelling an exact timer prevents delivery racing session lookup", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-id-race-"));
    const store = new AiTimerStore("/workspace", state);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = { get: vi.fn(async () => { await gate; return { status: "done", messages: [] }; }), send: vi.fn(), steer: vi.fn() };
    const service = new AiTimerService(store, { get: () => provider } as never, "/workspace", vi.fn());
    const timer = await service.schedule("/hidden/workflow", "codex", "Resume", 60);
    const firing = service.fireById(timer.id);
    await vi.waitFor(() => expect(provider.get).toHaveBeenCalled());
    await service.cancel(timer.id); release(); await firing;
    expect(provider.send).not.toHaveBeenCalled();
    await service.cancelAll();
  });

  it("preserves concurrent timers and cancellation across store instances", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-concurrent-timers-"));
    const first = new AiTimerStore("/workspace", state); const second = new AiTimerStore("/workspace", state);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).set(`/task/${i}`, "codex", "continue", 60)));
    expect(await first.list()).toHaveLength(12);
    await Promise.all([first.removeWorkspace("/task/0"), second.set("/task/new", "codex", "new", 60)]);
    const timers = await first.list();
    expect(timers).toHaveLength(12);
    expect(timers.some((timer) => timer.workspace === "/task/0")).toBe(false);
    expect(timers.some((timer) => timer.workspace === "/task/new")).toBe(true);
  });
  it("persists a replacement timer per workspace and provider", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
    const store = new AiTimerStore("/workspace", state);
    await store.set("/workspace/task", "codex", "First", 60);
    const replacement = await store.set("/workspace/task", "codex", "Second", 120);
    expect(await store.list()).toEqual([replacement]);
    await expect(store.next("/workspace/task")).resolves.toEqual(replacement);
  });

  it("returns the existing workflow timer for the same operation key", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-idempotent-timer-")); const store = new AiTimerStore("/workspace", state);
    const workflow = { runId: "run", blockId: "worker", operationKey: "timer-once" };
    const first = await store.set("/workspace/task", "codex", "First", 60, workflow);
    const replay = await store.set("/workspace/task", "codex", "First", 60, workflow);
    expect(replay).toEqual(first); expect(await store.list()).toEqual([first]);
  });

  it("reconciles a crash after workflow timer delivery without sending twice", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-crash-recovery-")); const store = new AiTimerStore("/workspace", state);
    const session = { status: "done", model: "gpt-5", reasoning: "low", messages: [] as Array<{ id: string; role: "user"; text: string; timestamp: string }> };
    const provider = { get: vi.fn(async () => session), send: vi.fn(async (_workspace: string, request: { prompt: string }) => { session.messages.push({ id: "continued", role: "user", text: request.prompt, timestamp: "now" }); return session; }), steer: vi.fn() };
    let crash = true;
    const operation = async <T>(_timer: unknown, effect: () => Promise<T>, reconcile: () => Promise<T | null | undefined>): Promise<T> => {
      if (crash) { crash = false; await effect(); throw new Error("Core crashed before committing timer outcome"); }
      const recovered = await reconcile(); if (recovered === null) return effect(); if (recovered === undefined) throw new Error("ambiguous timer outcome"); return recovered;
    };
    const first = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", vi.fn(), operation);
    await first.schedule("/workspace/task", "codex", "Continue once", 60, { runId: "run", blockId: "worker", operationKey: "timer-once" });
    await expect(first.fireNext("/workspace/task")).rejects.toThrow("Core crashed"); expect(provider.send).toHaveBeenCalledOnce(); expect(await store.list()).toHaveLength(1);
    const restarted = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", vi.fn(), operation);
    await expect(restarted.fireNext("/workspace/task")).resolves.toBe(true); expect(provider.send).toHaveBeenCalledOnce(); expect(await store.list()).toEqual([]);
  });

  it("sends the continuation prompt when the timer expires", async () => {
    vi.useFakeTimers();
    let state: string | undefined;
    let service: AiTimerService | undefined;
    try {
      state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
      const store = new AiTimerStore("/workspace", state);
      const session = { status: "done", model: "gpt-5", reasoning: "low", configuration: { model: "gpt-5", reasoning: "low" }, messages: [] };
      const provider = { get: vi.fn(async () => session), send: vi.fn(async () => ({ ...session, status: "in_progress" })), steer: vi.fn() };
      const changed = vi.fn();
      service = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", changed);
      await service.schedule("/workspace/task", "codex", "Continue now", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(provider.send).toHaveBeenCalledWith("/workspace/task", expect.objectContaining({ prompt: "Continue now", configuration: session.configuration, mcpServers: [expect.objectContaining({ name: "vibe-editor" })] })));
      await service.suspend();
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await service?.suspend();
      if (state) await rm(state, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps a long timer durable across the maximum-timeout wake and fires at its due time", async () => {
    vi.useFakeTimers();
    let state: string | undefined;
    let first: AiTimerService | undefined;
    let restarted: AiTimerService | undefined;
    try {
      const startAt = Date.now();
      state = await mkdtemp(path.join(os.tmpdir(), "vibe-long-timer-wake-"));
      const store = new AiTimerStore("/workspace", state);
      const session = { status: "done", model: "gpt-5", reasoning: "low", messages: [] };
      const provider = { get: vi.fn(async () => session), send: vi.fn(async () => session), steer: vi.fn() };
      const acp = { get: vi.fn(() => provider) } as never;
      first = new AiTimerService(store, acp, "/workspace", vi.fn());
      const dueAt = new Date(startAt + 30 * 24 * 60 * 60 * 1_000).toISOString();
      const timer = await first.scheduleAt("/workspace/task", "codex", "Long wait", dueAt);

      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await first.suspend();
      await expect(store.list()).resolves.toEqual([timer]);
      expect(provider.send).not.toHaveBeenCalled();

      restarted = new AiTimerService(store, acp, "/workspace", vi.fn());
      await restarted.start();
      await vi.advanceTimersByTimeAsync(Date.parse(dueAt) - Date.now());
      await restarted.suspend();
      expect(provider.send).toHaveBeenCalledOnce();
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await first?.suspend();
      await restarted?.suspend();
      if (state) await rm(state, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("preserves typed MCP tools and the next five-minute timer across repeated cycles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "flow-repeat-timer-")); const store = new AiTimerStore("/workspace", directory);
    const startedAt = Date.now(); vi.useFakeTimers(); vi.setSystemTime(startedAt);
    let cycle = 1;
    const provider = { get: vi.fn(async () => ({ status: "done", messages: [] })), send: vi.fn(async () => {
      cycle += 1;
      await service.schedule("/workspace/agent", "codex", "repeat", 300, { runId: "run", blockId: "agent", flow: true, operationKey: `cycle-${cycle}` });
    }), steer: vi.fn() };
    const service = new AiTimerService(store, { get: () => provider } as never, "/workspace", vi.fn());
    try {
      await service.schedule("/workspace/agent", "codex", "repeat", 300, { runId: "run", blockId: "agent", flow: true, operationKey: "cycle-1" });
      for (let index = 0; index < 2; index += 1) {
        await service.fireNext("/workspace/agent");
        expect(await store.list()).toMatchObject([{ workflowFlow: true, workflowOperationKey: `cycle-${index + 2}` }]);
        expect(Date.parse((await store.next("/workspace/agent"))!.dueAt) - Date.now()).toBeGreaterThan(299_000);
      }
      expect(provider.send).toHaveBeenCalledTimes(2);
      expect(provider.send).toHaveBeenLastCalledWith("/workspace/agent", expect.objectContaining({ mcpServers: [expect.objectContaining({ env: expect.objectContaining({ VIBE_EDITOR_FLOW_TOOLS: "1" }) })] }));
    } finally { await service.cancelWorkspace("/workspace/agent"); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); }
  });

  it("cancels the next timer without delivering it", async () => {
    vi.useFakeTimers();
    try {
      const state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
      const store = new AiTimerStore("/workspace", state);
      const provider = { get: vi.fn(), send: vi.fn(), steer: vi.fn() };
      const changed = vi.fn();
      const service = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", changed);
      await service.schedule("/workspace/task", "codex", "Do not send", 60);

      await expect(service.cancelNext("/workspace/task")).resolves.toBe(true);
      await expect(service.cancelNext("/workspace/task")).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.send).not.toHaveBeenCalled();
      await expect(store.list()).resolves.toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("fires the next timer immediately", async () => {
    vi.useFakeTimers();
    try {
      const state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
      const store = new AiTimerStore("/workspace", state);
      const session = { status: "done", model: "gpt-5", reasoning: "low", messages: [] };
      const provider = { get: vi.fn(async () => session), send: vi.fn(async () => session), steer: vi.fn() };
      const service = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", vi.fn());
      await service.schedule("/workspace/task", "codex", "Send now", 60);

      await expect(service.fireNext("/workspace/task")).resolves.toBe(true);
      expect(provider.send).toHaveBeenCalledWith("/workspace/task", expect.objectContaining({ prompt: "Send now" }));
      await expect(service.fireNext("/workspace/task")).resolves.toBe(false);
      await expect(store.list()).resolves.toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

it("rejects invalid new timer timestamps without corrupting an existing timer file", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "vibe-timer-invalid-new-"));
  const store = new AiTimerStore("/workspace", state);
  try {
    const existing = await store.setAt("/task", "codex", "preserve", new Date(Date.now() + 60_000).toISOString());
    await expect(store.setAt("/task", "codex", "invalid", "not-a-date")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await store.list()).toEqual([existing]);
  } finally { await rm(state, { recursive: true, force: true }); }
});
