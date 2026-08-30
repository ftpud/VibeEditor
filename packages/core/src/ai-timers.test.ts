import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AiTimerService, AiTimerStore } from "./ai-timers.js";

describe("AI continuation timers", () => {
  it("persists a replacement timer per workspace and provider", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-ai-timers-"));
    const store = new AiTimerStore("/workspace", state);
    await store.set("/workspace/task", "codex", "First", 60);
    const replacement = await store.set("/workspace/task", "codex", "Second", 120);
    expect(await store.list()).toEqual([replacement]);
    await expect(store.next("/workspace/task")).resolves.toEqual(replacement);
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
