import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AiTimerService, AiTimerStore } from "./ai-timers.js";

describe("AI continuation timers", () => {
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
    try {
      const state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
      const store = new AiTimerStore("/workspace", state);
      const session = { status: "done", model: "gpt-5", reasoning: "low", configuration: { model: "gpt-5", reasoning: "low" }, messages: [] };
      const provider = { get: vi.fn(async () => session), send: vi.fn(async () => ({ ...session, status: "in_progress" })), steer: vi.fn() };
      const changed = vi.fn();
      const service = new AiTimerService(store, { get: vi.fn(() => provider) } as never, "/workspace", changed);
      await service.schedule("/workspace/task", "codex", "Continue now", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(provider.send).toHaveBeenCalledWith("/workspace/task", expect.objectContaining({ prompt: "Continue now", configuration: session.configuration, mcpServers: [expect.objectContaining({ name: "vibe-editor" })] })));
      await expect(store.list()).resolves.toEqual([]);
    } finally { vi.useRealTimers(); }
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
