import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { HarnessBlock } from "@remote-ide/protocol";
import { connectedInput, HarnessRunner, nextWatchdogReset, isRecoverableWorkflowError } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";

describe("HarnessRunner", () => {
  it("recovers owned children with bounded retries and includes children in cancellation", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-children-")); const store = new HarnessStore("/workspace", state);
    const definition = await store.create("Children");
    await store.update({ ...definition, blocks: [{ id: "owner", type: "task", label: "Owner", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async () => { await waiting; return session("done"); });
    await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(true));
    const child = { taskId: "child", blockId: "owner", provider: "codex", workspace: "/child" };
    try {
      await runner.registerChild(run.id, child); await runner.registerChild(run.id, child);
      expect((await store.runs())[0]?.children).toHaveLength(1);
      const resume = vi.fn();
      await runner.recoverChildren(run.id, async () => session("healthy"), resume);
      expect(resume).not.toHaveBeenCalled();
      const failed = { ...session("failed"), status: "error" as const, messages: [{ id: "error", role: "error" as const, text: "Usage limit reached", timestamp: "now" }] };
      for (let i = 0; i < 5; i++) await runner.recoverChildren(run.id, async () => failed, resume);
      expect(resume).toHaveBeenCalledTimes(3);
      expect((await store.runs())[0]?.children?.[0]?.recoveryAttempts).toBe(3);
      const interrupt = vi.fn(async () => { release(); });
      await runner.cancel(run.id, interrupt);
      expect(interrupt).toHaveBeenCalledWith("codex", expect.objectContaining({ workspace: "/child" }));
      await runner.recoverChildren(run.id, async () => failed, resume);
      expect(resume).toHaveBeenCalledTimes(3);
    } finally { release(); }
  });
  it("waits for all exhausted quota windows and tolerates missing reset information", () => {
    const now = Date.parse("2026-09-18T00:00:00Z");
    const primary = { usedPercent: 100, remainingPercent: 0, resetsAt: "2026-09-18T01:00:00Z" };
    const secondary = { usedPercent: 100, remainingPercent: 0, resetsAt: "2026-09-19T00:00:00Z" };
    expect(nextWatchdogReset({ supported: true, accountQuota: { primary, secondary } }, now)).toBe("2026-09-19T00:00:00.000Z");
    expect(nextWatchdogReset({ supported: true, accountQuota: { primary: { ...primary, remainingPercent: 50, usedPercent: 50 }, secondary } }, now)).toBe("2026-09-19T00:00:00.000Z");
    expect(nextWatchdogReset(undefined, now)).toBe("2026-09-18T00:05:00.000Z");
    expect(isRecoverableWorkflowError("Internal error: You've hit your usage limit")).toBe(true);
    expect(isRecoverableWorkflowError("Merge conflict in main.ts")).toBe(false);
    expect(isRecoverableWorkflowError("Permission denied")).toBe(false);
  });

  it("runs a Core watchdog independently without an AI session and cancels its sleep", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "core-watchdog-"));
    const store = new HarnessStore("/workspace", state); const definition = await store.create("Core watchdog");
    await store.update({ ...definition, blocks: ["watchdog", "main"].map((id) => ({ id, label: id, prompt: "work", type: "prompt" as const, watchdog: id === "watchdog", position: { x: 0, y: 0 } })), edges: [] });
    const runner = new HarnessRunner(store, () => undefined);
    const usage = vi.fn(async () => ({ supported: false }));
    const run = await runner.start(definition.id, "work", async (block, _prompt, runtime) => block.watchdog ? runner.watch(runtime.runId, block.id, usage) : session("complete"));
    try {
      await vi.waitFor(async () => {
        const current = (await store.runs())[0]!;
        expect(current.blocks.find((b) => b.blockId === "main")?.status).toBe("succeeded");
        expect(current.blocks.find((b) => b.blockId === "watchdog")?.waitingUntil).toBeTruthy();
        expect(current.blocks.find((b) => b.blockId === "watchdog")?.sessionId).toBeUndefined();
      });
    } finally { await runner.cancel(run.id, async () => undefined); }
    await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(false));
    expect(usage).toHaveBeenCalledOnce();
  });
  it("runs the pipeline beside a sleeping watchdog and resumes failures without replaying completed stages", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-watchdog-"));
    const store = new HarnessStore("/workspace", state); const definition = await store.create("Independent watchdog");
    const blocks: HarnessBlock[] = ["watchdog", "plan", "implement", "report"].map((id) => ({ id, type: "prompt", label: id, prompt: "{{input}}", position: { x: 0, y: 0 }, ...(id === "watchdog" ? { watchdog: true } : {}) }));
    await store.update({ ...definition, blocks, edges: [{ id: "a", from: "plan", to: "implement" }, { id: "b", from: "implement", to: "report" }] });
    let release!: () => void; const sleeping = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined);
    const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, context: { started(workspace: string): Promise<void> }) => {
      await context.started(`/session/${block.id}`);
      if (block.id === "watchdog") await sleeping;
      if (block.id === "implement") throw new Error("Usage limit reached");
      return session(block.id);
    });
    const append = vi.fn(async () => session("recovered"));
    const run = await runner.start(definition.id, "request", dispatch, "test", append);
    try {
      await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((b) => b.blockId === "implement")?.status).toBe("failed"));
      expect((await store.runs())[0]?.status).toBe("running");
      expect(await runner.resumeFailed(run.id, "watchdog")).toEqual({ resumed: ["implement"] });
      expect(await runner.resumeFailed(run.id, "watchdog")).toEqual({ resumed: [] });
      await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((b) => b.blockId === "report")?.status).toBe("succeeded"));
      expect(append).toHaveBeenCalledOnce();
      expect(append.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ workspace: "/session/implement" })]));
      expect(dispatch.mock.calls.filter(([b]) => b.id === "plan")).toHaveLength(1);
      await runner.cancel(run.id, async () => release());
      await expect(runner.resumeFailed(run.id, "watchdog")).rejects.toThrow("no longer active");
    } finally { release(); }
  });
  it("runs blocks in dependency order and passes connected output as input", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-runner-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Flow");
    await store.update({ ...definition, blocks: [{ id: "one", type: "prompt", label: "One", prompt: "Plan {{input}}", position: { x: 0, y: 0 } }, { id: "two", type: "prompt", label: "Two", prompt: "Build {{input}}", position: { x: 1, y: 1 } }], edges: [{ id: "edge", from: "one", to: "two" }] });
    const dispatch = vi.fn(async (_block, prompt: string) => ({ id: prompt, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: prompt, role: "assistant" as const, text: prompt.startsWith("Plan feature") ? "the plan" : "complete", timestamp: "now" }] }));
    const runner = new HarnessRunner(store, () => undefined); const started = await runner.start(definition.id, "feature", dispatch, "test");
    for (let tries = 0; tries < 30; tries += 1) { const current = (await store.runs())[0]; if (current?.status === "succeeded") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const completed = (await store.runs())[0]!;
    expect(completed.status).toBe("succeeded"); expect(dispatch.mock.calls.map((call) => call[1].split("\n\nWorkflow runtime")[0])).toEqual(["Plan feature", "Build the plan"]); expect(completed.id).toBe(started.id);
  });

  it("cycles through an explicit loop edge without rescheduling the initial graph", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-cycle-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Cycle");
    const blocks: HarnessBlock[] = [{ id: "draft", type: "task", label: "Draft", prompt: "Draft {{input}}", position: { x: 0, y: 0 } }, { id: "review", type: "prompt", label: "Review", prompt: "Review {{input}}", position: { x: 200, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "forward", from: "draft", to: "review" }, { id: "loop", from: "review", to: "draft", label: "revise", loop: true }] });
    const runner = new HarnessRunner(store, () => undefined); const append = vi.fn(async (_block: HarnessBlock, prompt: string) => session(`revised:${prompt}`));
    const dispatch = vi.fn(async (block: HarnessBlock, prompt: string, runtime: { runId: string; blockId: string; started(workspace: string): Promise<void> }) => {
      await runtime.started(`/sessions/${block.id}`);
      if (block.id === "review") await runner.runStack(runtime.runId, runtime.blockId, ["Address the review"], "revise");
      return session(prompt);
    });
    await runner.start(definition.id, "feature", dispatch, "test", append);
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    expect(dispatch.mock.calls.map((call) => call[0].id)).toEqual(["draft", "review"]);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ id: "draft" }), "Address the review", expect.objectContaining({ workspace: "/sessions/draft" }));
  });

  it("combines direct predecessor outputs for a join block", () => {
    const blocks = [{ id: "a", type: "prompt" as const, label: "Research", prompt: "", position: { x: 0, y: 0 } }, { id: "b", type: "prompt" as const, label: "Review", prompt: "", position: { x: 0, y: 0 } }, { id: "c", type: "prompt" as const, label: "Write", prompt: "", position: { x: 0, y: 0 } }];
    expect(connectedInput("c", "original", blocks, [{ id: "ac", from: "a", to: "c" }, { id: "bc", from: "b", to: "c" }], new Map([["a", "facts"], ["b", "notes"]]))).toBe("## Research\nfacts\n\n## Review\nnotes");
  });

  it("cancels a persisted running run after the server restarts", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-restart-")); const store = new HarnessStore("/workspace", state);
    await store.saveRun({ id: "orphan", harnessId: "flow", harnessVersion: 1, input: "task", status: "running", createdAt: "now", startedAt: "now", blocks: [{ blockId: "one", status: "succeeded", output: "done" }, { blockId: "two", status: "running", startedAt: "now" }, { blockId: "three", status: "queued" }] });
    const changed = vi.fn(); const interrupt = vi.fn();

    const cancelled = await new HarnessRunner(store, changed).cancel("orphan", interrupt);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.blocks.map((block) => block.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect((await store.runs())[0]).toEqual(cancelled);
    expect(changed).toHaveBeenCalledWith("orphan");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("interrupts each running block before persisting its cancelled state", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-cancel-")); const store = new HarnessStore("/workspace", state);
    await store.saveRun({ id: "active", harnessId: "flow", harnessVersion: 1, input: "task", status: "running", createdAt: "now", startedAt: "now", blocks: [{ blockId: "left", status: "running", provider: "codex" }, { blockId: "right", status: "running", provider: "claude" }] });
    const interrupt = vi.fn().mockResolvedValue(undefined);

    await new HarnessRunner(store, () => undefined).cancel("active", interrupt);

    expect(interrupt.mock.calls).toEqual([["codex", { runId: "active", blockId: "left" }], ["claude", { runId: "active", blockId: "right" }]]);
  });

  it("fans out ready blocks concurrently and waits for all before joining", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-fanout-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Fan out");
    const blocks = ["root", "left", "right", "join"].map((id) => ({ id, type: "prompt" as const, label: id, prompt: "{{input}}", position: { x: 0, y: 0 } }));
    await store.update({ ...definition, blocks, edges: [{ id: "rl", from: "root", to: "left" }, { id: "rr", from: "root", to: "right" }, { id: "lj", from: "left", to: "join" }, { id: "rj", from: "right", to: "join" }] });
    let active = 0; let maxActive = 0; const completed: string[] = [];
    const dispatch = vi.fn(async (block: HarnessBlock) => { active += 1; maxActive = Math.max(maxActive, active); if (block.id === "left" || block.id === "right") await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; completed.push(block.id); return { id: block.id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: block.id, role: "assistant" as const, text: block.id, timestamp: "now" }] }; });
    await new HarnessRunner(store, () => undefined).start(definition.id, "go", dispatch, "test");
    for (let tries = 0; tries < 50 && (await store.runs())[0]?.status !== "succeeded"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maxActive).toBe(2); expect(completed.at(-1)).toBe("join");
  });

  it("lets AI select one named path and skips the other paths", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-routing-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Route");
    const blocks = [{ id: "router", type: "prompt" as const, label: "Router", prompt: "Choose", routing: "ai" as const, position: { x: 0, y: 0 } }, { id: "left", type: "prompt" as const, label: "Left", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "right", type: "prompt" as const, label: "Right", prompt: "{{input}}", position: { x: 0, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "left-edge", from: "router", to: "left", label: "left" }, { id: "right-edge", from: "router", to: "right", label: "right" }] });
    const runner = new HarnessRunner(store, () => undefined); const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string }) => { if (block.id === "router") await runner.runStack(runtime.runId, runtime.blockId, ["selected work"], "right"); return { id: block.id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: block.id, role: "assistant" as const, text: "finished", timestamp: "now" }] }; });
    await runner.start(definition.id, "go", dispatch, "test");
    for (let tries = 0; tries < 50 && (await store.runs())[0]?.status !== "succeeded"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const run = (await store.runs())[0]!;
    expect(dispatch.mock.calls.map((call) => call[0].id)).toEqual(["router", "right"]);
    expect(run.blocks.find((block) => block.blockId === "router")?.selectedRoute).toBe("right");
    expect(run.blocks.find((block) => block.blockId === "left")?.status).toBe("skipped");
  });

  it("starts an any-join after the first active input without waiting for slower paths", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-any-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Any join");
    const blocks: HarnessBlock[] = [{ id: "root", type: "prompt", label: "Root", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "slow", type: "prompt", label: "Slow", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "fast", type: "prompt", label: "Fast", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "join", type: "prompt", label: "Join", prompt: "Join {{input}}", join: "any", position: { x: 0, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "rs", from: "root", to: "slow" }, { id: "rf", from: "root", to: "fast" }, { id: "sj", from: "slow", to: "join" }, { id: "fj", from: "fast", to: "join" }] });
    const events: string[] = []; const dispatch = vi.fn(async (block: HarnessBlock, prompt: string) => { events.push(`${block.id}-start`); if (block.id === "slow") await new Promise((resolve) => setTimeout(resolve, 30)); if (block.id === "fast") await new Promise((resolve) => setTimeout(resolve, 5)); events.push(`${block.id}-done`); return { id: block.id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: block.id, role: "assistant" as const, text: block.id, timestamp: "now" }] }; });
    await new HarnessRunner(store, () => undefined).start(definition.id, "go", dispatch, "test");
    for (let tries = 0; tries < 50 && (await store.runs())[0]?.status !== "succeeded"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.indexOf("join-start")).toBeLessThan(events.indexOf("slow-done"));
    expect(dispatch.mock.calls.find((call) => call[0].id === "join")?.[1]).toBe("Join fast");
  });

  it("lets an upstream AI create distinct downstream stack items and waits for all of them", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-dynamic-stack-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Dynamic stack");
    const blocks: HarnessBlock[] = [{ id: "planner", type: "prompt", label: "Planner", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "worker", type: "prompt", label: "Worker", prompt: "Work {{iteration}}: {{input}}", position: { x: 0, y: 0 } }, { id: "finish", type: "prompt", label: "Finish", prompt: "Finish {{input}}", position: { x: 0, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "pw", from: "planner", to: "worker" }, { id: "wf", from: "worker", to: "finish" }] });
    const runner = new HarnessRunner(store, () => undefined); const calls: Array<{ id: string; prompt: string }> = []; let toolResult: unknown; const dispatch = vi.fn(async (block: HarnessBlock, prompt: string, runtime: { runId: string; blockId: string; started(workspace: string): Promise<void> }) => { calls.push({ id: block.id, prompt }); if (block.id === "planner") toolResult = await runner.runStack(runtime.runId, runtime.blockId, ["research user prompt", "implement user prompt", "review user prompt"]); if (block.id === "worker") await runtime.started("/sessions/worker"); const text = block.id === "planner" ? `I reviewed the stack results: ${JSON.stringify(toolResult)}` : block.id === "worker" ? `result ${calls.filter((call) => call.id === "worker").length}` : "done"; return { id: `${block.id}-${calls.length}`, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: block.id, role: "assistant" as const, text, timestamp: "now" }] }; });
    const append = vi.fn(async (block: HarnessBlock, prompt: string) => { calls.push({ id: block.id, prompt }); return session(`result ${calls.filter((call) => call.id === "worker").length}`); });
    await runner.start(definition.id, "Create 3 stacks for downstream flow with the user prompt", dispatch, "test", append);
    for (let tries = 0; tries < 50 && (await store.runs())[0]?.status !== "succeeded"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const run = (await store.runs())[0]!; const workerCalls = calls.filter((call) => call.id === "worker"); const finishCall = calls.find((call) => call.id === "finish");
    expect(calls[0]?.prompt).toContain("workflow_run_stack"); expect(calls[0]?.prompt).toContain("appended to that same session"); expect(calls[0]?.prompt).toContain("timer_set");
    expect(workerCalls).toHaveLength(3); expect(workerCalls.map((call) => call.prompt.split("\n\nWorkflow runtime")[0])).toEqual(["Work 1: research user prompt", "Work 2: implement user prompt", "Work 3: review user prompt"]);
    expect(finishCall?.prompt).toContain("## Stack item 3\nresult 3"); expect(toolResult).toEqual({ blocks: [{ blockId: "worker", output: expect.stringContaining("## Stack item 3\nresult 3") }] }); expect(run.blocks[0]?.output).toContain("I reviewed the stack results"); expect(run.blocks[1]?.plannedRuns).toBe(3); expect(run.blocks[1]?.iterations).toHaveLength(3);
  });

  it("appends a later upstream prompt to an already-running downstream session", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-persistent-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Persistent sessions");
    const blocks: HarnessBlock[] = [{ id: "first", type: "prompt", label: "First", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "later", type: "prompt", label: "Later", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "worker", type: "task", label: "Worker", prompt: "{{input}}", position: { x: 0, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "fw", from: "first", to: "worker" }, { id: "lw", from: "later", to: "worker" }] });
    const runner = new HarnessRunner(store, () => undefined); const append = vi.fn(async (_block: HarnessBlock, prompt: string, runtime: { workspace: string }) => session(`appended:${runtime.workspace}:${prompt}`));
    const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string; started(workspace: string): Promise<void> }) => {
      if (block.id === "first") await runner.runStack(runtime.runId, runtime.blockId, ["initial"]);
      if (block.id === "later") { await new Promise((resolve) => setTimeout(resolve, 40)); await runner.runStack(runtime.runId, runtime.blockId, ["follow-up"]); }
      if (block.id === "worker") { await runtime.started("/sessions/worker"); await new Promise((resolve) => setTimeout(resolve, 120)); }
      return session(block.id);
    });
    await runner.start(definition.id, "build", dispatch, "test", append);
    for (let tries = 0; tries < 150 && (await store.runs())[0]?.status !== "succeeded"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ id: "worker" }), "follow-up", expect.objectContaining({ workspace: "/sessions/worker" }));
  });
});

function session(id: string) { return { id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id, role: "assistant" as const, text: id, timestamp: "now" }] }; }
