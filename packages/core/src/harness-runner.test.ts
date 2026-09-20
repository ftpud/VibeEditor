import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { HarnessBlock, HarnessOperationKind } from "@remote-ide/protocol";
import { AiProviderError } from "@remote-ide/acp";
import { classifyWorkflowFailure, connectedInput, HarnessRunner, nextWatchdogReset, isRecoverableWorkflowError } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";

describe("HarnessRunner", () => {
  it("reconciles a completed provider turn after restart without sending its prompt again", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-restart-complete-")); const store = new HarnessStore("/workspace", state); const created = await store.create("Recovery");
    const definition = await store.update({ ...created, blocks: [{ id: "first", type: "prompt", label: "First", prompt: "{{input}}", position: { x: 0, y: 0 } }, { id: "second", type: "prompt", label: "Second", prompt: "Use {{input}}", position: { x: 0, y: 0 } }], edges: [{ id: "next", from: "first", to: "second" }] });
    await store.saveRun({ id: "recover-complete", harnessId: definition.id, harnessVersion: definition.version, definition, executionPlan: { version: 1, createdAt: "now", definitionVersion: definition.version, order: ["first", "second"], blocks: [{ blockId: "first", incoming: [], outgoing: ["next"] }, { blockId: "second", incoming: ["next"], outgoing: [] }] }, input: "request", status: "running", createdAt: "now", startedAt: "now", blocks: [{ blockId: "first", status: "running", provider: "codex", workspace: "/workflow/first", sessionId: "session-first", attempts: [{ id: "attempt-first", index: 1, status: "running", startedAt: "now", operationId: "attempt-operation" }] }, { blockId: "second", status: "waiting" }], operations: [{ id: "attempt-operation", idempotencyKey: "block-attempt:first:1", kind: "block_attempt", status: "intent", blockId: "first", attemptId: "attempt-first", createdAt: "now", updatedAt: "now" }, { id: "prompt-operation", idempotencyKey: "prompt:first:attempt-first", kind: "prompt_delivery", status: "intent", blockId: "first", attemptId: "attempt-first", createdAt: "now", updatedAt: "now" }] });
    const dispatch = vi.fn(async (block: HarnessBlock, prompt: string) => session(`${block.id}:${prompt}`)); const append = vi.fn();
    const runner = new HarnessRunner(store, () => undefined); await runner.recover(dispatch, "codex", append, { session: async () => ({ ...session("session-first"), messages: [{ id: "answer", role: "assistant", text: "recovered output", timestamp: "now" }] }), timer: async () => false });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    const run = (await store.runs())[0]!; expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0]?.[0].id).toBe("second"); expect(dispatch.mock.calls[0]?.[1]).toContain("recovered output"); expect(append).not.toHaveBeenCalled();
    expect(run.blocks[0]).toMatchObject({ status: "succeeded", output: "recovered output" }); expect(run.operations?.filter((operation) => operation.blockId === "first").every((operation) => operation.status === "succeeded")).toBe(true);
  });

  it("pauses an orphaned provider turn until the user explicitly resumes it", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-restart-orphan-")); const store = new HarnessStore("/workspace", state); const created = await store.create("Recovery");
    const definition = await store.update({ ...created, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "{{input}}", position: { x: 0, y: 0 } }], edges: [] });
    await store.saveRun({ id: "recover-orphan", harnessId: definition.id, harnessVersion: definition.version, definition, executionPlan: { version: 1, createdAt: "now", definitionVersion: definition.version, order: ["worker"], blocks: [{ blockId: "worker", incoming: [], outgoing: [] }] }, input: "request", status: "running", createdAt: "now", startedAt: "now", blocks: [{ blockId: "worker", status: "running", provider: "codex", workspace: "/workflow/worker", sessionId: "missing" }] });
    const dispatch = vi.fn(); const append = vi.fn(async (_block: HarnessBlock, _prompt: string) => session("continued")); const runner = new HarnessRunner(store, () => undefined);
    const recovered = await runner.recover(dispatch, "codex", append, { session: async () => undefined, timer: async () => false });
    expect(recovered[0]).toMatchObject({ status: "retry_scheduled", blocks: [{ status: "retry_scheduled", failureReason: "recovery_orphaned", error: expect.stringContaining("no longer exists") }] }); expect(dispatch).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    const pauseId = recovered[0]!.blocks[0]!.pauseId!; await runner.retryPause("recover-orphan", "worker", pauseId);
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded")); expect(append).toHaveBeenCalledOnce(); expect(append.mock.calls[0]?.[1]).toContain("Continue your interrupted work");
  });

  it("persists a versioned execution plan, attempts, and terminal operation journal", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-journal-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Journal");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "{{input}}", position: { x: 0, y: 0 } }], edges: [] });
    const runner = new HarnessRunner(store, () => undefined); await runner.start(definition.id, "work", async (_block, _prompt, runtime) => { await runtime.started("/workflow/worker"); return session("session-1"); });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    const run = (await store.runs())[0]!; const attempt = run.blocks[0]!.attempts?.[0]!;
    expect(run.executionPlan).toMatchObject({ version: 1, definitionVersion: 2, order: ["worker"], blocks: [{ blockId: "worker", incoming: [], outgoing: [] }] });
    expect(attempt).toMatchObject({ index: 1, status: "succeeded", sessionId: "session-1", workspace: "/workflow/worker" });
    expect(run.operations?.map((operation) => operation.kind)).toEqual(expect.arrayContaining(["dependency_decision", "block_attempt", "prompt_delivery", "session_binding", "terminal_outcome"]));
    expect(run.operations?.every((operation) => operation.status === "succeeded")).toBe(true);
    expect(run.operations?.find((operation) => operation.id === attempt.operationId)?.attemptId).toBe(attempt.id);
  });

  it("deduplicates a concurrent external operation by its stable key", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-operation-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Operation");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let releaseBlock!: () => void; const blockWaiting = new Promise<void>((resolve) => { releaseBlock = resolve; }); const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async () => { await blockWaiting; return session("done"); });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("running"));
    let releaseEffect!: () => void; const effectWaiting = new Promise<void>((resolve) => { releaseEffect = resolve; }); const effect = vi.fn(async () => { await effectWaiting; return { taskId: "task-1" }; });
    const first = runner.runOperation(run.id, "worker", "task_create", "create-task", { branch: "feature" }, effect); const replay = runner.runOperation(run.id, "worker", "task_create", "create-task", { branch: "feature" }, effect);
    releaseEffect(); expect(await Promise.all([first, replay])).toEqual([{ taskId: "task-1" }, { taskId: "task-1" }]); expect(effect).toHaveBeenCalledOnce();
    expect((await store.runs())[0]?.operations?.find((operation) => operation.idempotencyKey === "worker:create-task")).toMatchObject({ kind: "task_create", status: "succeeded", result: { taskId: "task-1" } });
    const uncertain = vi.fn(async () => { throw new Error("reply lost after task creation"); });
    await expect(runner.runOperation(run.id, "worker", "task_create", "uncertain-task", { branch: "uncertain" }, uncertain)).rejects.toThrow("reply lost");
    expect((await store.runs())[0]?.operations?.find((operation) => operation.idempotencyKey === "worker:uncertain-task")).toMatchObject({ status: "intent", error: "reply lost after task creation" });
    const reconcile = vi.fn(async () => ({ taskId: "task-existing" }));
    await expect(runner.runOperation(run.id, "worker", "task_create", "uncertain-task", { branch: "uncertain" }, uncertain, reconcile)).resolves.toEqual({ taskId: "task-existing" });
    expect(uncertain).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
    releaseBlock(); await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
  });

  it.each(["task_create", "prompt_delivery", "timer_fire", "merge"] satisfies HarnessOperationKind[])("recovers a %s crash before or after its side effect exactly once", async (kind) => {
    for (const crash of ["before", "after"] as const) {
      const stateDirectory = await mkdtemp(path.join(os.tmpdir(), `workflow-${kind}-${crash}-`)); const store = new HarnessStore("/workspace", stateDirectory); const created = await store.create("Crash recovery");
      const definition = await store.update({ ...created, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "finish", position: { x: 0, y: 0 } }], edges: [] });
      const pauseId = `${kind}-${crash}-pause`; const operationKey = `worker:${kind}-operation`; const now = new Date().toISOString();
      await store.saveRun({ id: `${kind}-${crash}`, harnessId: definition.id, harnessVersion: definition.version, definition, executionPlan: { version: 1, createdAt: now, definitionVersion: definition.version, order: ["worker"], blocks: [{ blockId: "worker", incoming: [], outgoing: [] }] }, input: "request", status: "retry_scheduled", createdAt: now, startedAt: now, blocks: [{ blockId: "worker", status: "retry_scheduled", pauseId, error: "Core stopped at the fault point", failureReason: "recovery_orphaned" }], operations: [{ id: `${kind}-${crash}-operation-id`, idempotencyKey: operationKey, kind, status: "intent", blockId: "worker", createdAt: now, updatedAt: now }] });
      const runner = new HarnessRunner(store, () => undefined); const dispatch = vi.fn(async () => session("completed"));
      await runner.recover(dispatch, "test");
      let external = crash === "after" ? { id: `${kind}-existing` } : undefined; const effect = vi.fn(async () => { external = { id: `${kind}-created` }; return external; }); const reconcile = vi.fn(async () => external ?? null);
      const result = await runner.runOperation(`${kind}-${crash}`, "worker", kind, `${kind}-operation`, { fault: crash }, effect, reconcile);
      expect(result).toEqual(crash === "after" ? { id: `${kind}-existing` } : { id: `${kind}-created` }); expect(effect).toHaveBeenCalledTimes(crash === "after" ? 0 : 1); expect(reconcile).toHaveBeenCalledOnce();
      await runner.retryPause(`${kind}-${crash}`, "worker", pauseId);
      await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
      const operation = (await store.runs())[0]!.operations?.find((item) => item.idempotencyKey === operationKey); expect(operation).toMatchObject({ status: "succeeded", result }); expect(dispatch).toHaveBeenCalledOnce();
    }
  });

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
    expect(classifyWorkflowFailure("HTTP 429: rate limit")).toBe("quota_exhausted");
    expect(classifyWorkflowFailure("socket hang up")).toBe("transient_transport");
    expect(classifyWorkflowFailure("Approval required for tool call")).toBe("permission_required");
    expect(classifyWorkflowFailure("requires user input")).toBe("user_input_required");
    expect(classifyWorkflowFailure("Invalid request")).toBe("permanent");
    expect(classifyWorkflowFailure(new AiProviderError({ kind: "transient_transport", message: "opaque provider failure" }))).toBe("transient_transport");
  });

  it("backs off transport failures and never retries permanent or paused failures", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-retry-policy-")); const store = new HarnessStore("/workspace", state);
    const definition = await store.create("Retry policy");
    const blocks: HarnessBlock[] = ["watchdog", "transport", "permission"].map((id) => ({ id, type: "prompt", label: id, prompt: "work", watchdog: id === "watchdog", position: { x: 0, y: 0 } }));
    await store.update({ ...definition, blocks, edges: [] });
    let release!: () => void; const sleeping = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined, 4, { maxAttempts: 2, transportBackoffMs: 200, jitterRatio: 0 });
    const run = await runner.start(definition.id, "work", async (block) => {
      if (block.id === "watchdog") await sleeping;
      if (block.id === "transport") throw new Error("ETIMEDOUT");
      if (block.id === "permission") throw new Error("Approval required");
      return session("done");
    });
    try {
      await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.filter((block) => block.status === "failed" || block.status === "retry_scheduled")).toHaveLength(2));
      const current = (await store.runs())[0]!;
      expect(current.blocks.find((block) => block.blockId === "transport")?.failureReason).toBe("transient_transport");
      expect(current.blocks.find((block) => block.blockId === "transport")?.retryAt).toBeTruthy();
      expect(current.blocks.find((block) => block.blockId === "permission")?.failureReason).toBe("permission_required");
      expect(await runner.resumeFailed(run.id, "watchdog")).toEqual({ resumed: [] });
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(await runner.resumeFailed(run.id, "watchdog")).toEqual({ resumed: ["transport"] });
    } finally { await runner.cancel(run.id, async () => release()); release(); }
  });

  it("stops retries whose next backoff exceeds the elapsed retry budget", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-retry-budget-")); const store = new HarnessStore("/workspace", state);
    const definition = await store.create("Retry budget");
    await store.update({ ...definition, blocks: [
      { id: "watchdog", type: "prompt", label: "watchdog", prompt: "watch", watchdog: true, position: { x: 0, y: 0 } },
      { id: "worker", type: "prompt", label: "worker", prompt: "work", position: { x: 0, y: 0 } }
    ], edges: [] });
    const runner = new HarnessRunner(store, () => undefined, 4, { maxAttempts: 5, transportBackoffMs: 1_000, maxElapsedMs: 500, jitterRatio: 0 });
    await runner.start(definition.id, "work", async (block, _prompt, runtime) => block.watchdog ? runner.watch(runtime.runId, block.id, async () => ({ supported: false })) : Promise.reject(new AiProviderError({ kind: "transient_transport", message: "provider unavailable" })));
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("failed"));
    const worker = (await store.runs())[0]!.blocks.find((block) => block.blockId === "worker")!;
    expect(worker).toMatchObject({ status: "failed", failureReason: "transient_transport" });
    expect(worker.recoveryAttempts).toBeUndefined(); expect(worker.retryAt).toBeUndefined();
    expect(worker.retryStartedAt).toBeTruthy();
    expect(worker.error).toContain("Automatic retry budget exhausted");
  });

  it("stops a sleeping Core watchdog when delivery succeeds", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "core-watchdog-"));
    const store = new HarnessStore("/workspace", state); const definition = await store.create("Core watchdog");
    await store.update({ ...definition, blocks: ["watchdog", "main"].map((id) => ({ id, label: id, prompt: "work", type: "prompt" as const, watchdog: id === "watchdog", position: { x: 0, y: 0 } })), edges: [] });
    const runner = new HarnessRunner(store, () => undefined);
    const usage = vi.fn(async () => ({ supported: false }));
    const run = await runner.start(definition.id, "work", async (block, _prompt, runtime) => block.watchdog ? runner.watch(runtime.runId, block.id, usage) : session("complete"));
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    const completed = (await store.runs())[0]!;
    expect(completed.blocks.find((b) => b.blockId === "main")?.status).toBe("succeeded");
    const watchdog = completed.blocks.find((b) => b.blockId === "watchdog")!;
    expect(watchdog.status).toBe("succeeded");
    expect(watchdog.waitingUntil).toBeUndefined();
    expect(watchdog.sessionId).toBeUndefined();
    expect(watchdog.log?.some((entry) => entry.message === "Core watchdog stopped because delivery reached a terminal state")).toBe(true);
    await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(false));
    expect(usage).toHaveBeenCalledOnce();
  });

  it("stops the Core watchdog when delivery fails permanently", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "terminal-workflow-watchdog-"));
    const store = new HarnessStore("/workspace", state); const definition = await store.create("Terminal watchdog");
    await store.update({ ...definition, blocks: [
      { id: "watchdog", label: "watchdog", prompt: "", type: "prompt", watchdog: true, position: { x: 0, y: 0 } },
      { id: "main", label: "main", prompt: "work", type: "prompt", position: { x: 0, y: 0 } }
    ], edges: [] });
    const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async (block, _prompt, runtime) => {
      if (block.watchdog) return runner.watch(runtime.runId, block.id, async () => ({ supported: false }));
      throw new Error("Invalid delivery request");
    });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("failed"));
    const completed = (await store.runs())[0]!;
    expect(completed.blocks.find((block) => block.blockId === "watchdog")?.status).toBe("succeeded");
    expect(completed.blocks.find((block) => block.blockId === "main")?.failureReason).toBe("permanent");
    await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(false));
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
      await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((b) => b.blockId === "implement")?.status).toBe("retry_scheduled"));
      expect((await store.runs())[0]?.status).toBe("retry_scheduled");
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

  it("keeps an asynchronous AI-routed loop active across repeated session appends", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-async-cycle-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Cycle");
    const blocks: HarnessBlock[] = [
      { id: "start", type: "prompt", label: "START", prompt: "Start", position: { x: 0, y: 0 } },
      { id: "check", type: "prompt", label: "CHECK", prompt: "Check", routing: "ai", position: { x: 200, y: 0 } },
      { id: "exit", type: "prompt", label: "EXIT", prompt: "Exit", position: { x: 400, y: 0 } }
    ];
    await store.update({ ...definition, blocks, edges: [
      { id: "check", from: "start", to: "check", label: "CHECK", execution: "async" },
      { id: "continue", from: "check", to: "start", label: "CONTINUE", loop: true, execution: "async" },
      { id: "exit", from: "check", to: "exit", label: "EXIT", execution: "async" }
    ] });
    const runner = new HarnessRunner(store, () => undefined); let starts = 0; let checks = 0;
    const append = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string; workspace: string }) => {
      // START uses routing=all, so its ordinary CHECK edge must advance without
      // relying on the provider to repeat the workflow_run_stack tool call.
      if (block.id === "start") starts += 1;
      if (block.id === "check") { checks += 1; await runner.runStack(runtime.runId, runtime.blockId, [checks < 3 ? `continue ${checks}` : "done"], checks < 3 ? "CONTINUE" : "EXIT"); }
      return session(`${block.id} complete`);
    });
    const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string; started(workspace: string): Promise<void> }) => {
      await runtime.started(`/sessions/${block.id}`);
      if (block.id === "check") { checks += 1; await runner.runStack(runtime.runId, runtime.blockId, ["continue initial"], "CONTINUE"); }
      return session(`${block.id} complete`);
    });
    await runner.start(definition.id, "go", dispatch, "test", append);
    await vi.waitFor(async () => { const current = (await store.runs())[0]; if (current?.status === "failed") throw new Error(current.error); expect(current?.status).toBe("succeeded"); });
    await vi.waitFor(() => expect(dispatch.mock.calls.map((call) => call[0].id)).toContain("exit"));
    expect({ starts, checks }).toEqual({ starts: 2, checks: 3 });
    expect(append.mock.calls.map((call) => call[0].id)).toEqual(["start", "check", "start", "check"]);
    expect(dispatch.mock.calls.map((call) => call[0].id)).toEqual(["start", "check", "exit"]);
  });

  it("returns immediately across an async connection but keeps the workflow active", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-async-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Async");
    const blocks: HarnessBlock[] = [{ id: "planner", type: "prompt", label: "Planner", prompt: "Plan", position: { x: 0, y: 0 } }, { id: "worker", type: "task", label: "Worker", prompt: "{{input}}", position: { x: 200, y: 0 } }];
    await store.update({ ...definition, blocks, edges: [{ id: "async", from: "planner", to: "worker", execution: "async" }] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); let toolResult: unknown;
    const runner = new HarnessRunner(store, () => undefined); const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string }) => {
      if (block.id === "planner") toolResult = await runner.runStack(runtime.runId, runtime.blockId, ["build"]);
      if (block.id === "worker") await waiting;
      return session(block.id);
    });
    const run = await runner.start(definition.id, "feature", dispatch, "test");
    await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((block) => block.blockId === "planner")?.status).toBe("succeeded"));
    expect(toolResult).toEqual({ blocks: [{ blockId: "worker", output: "" }] });
    expect((await store.runs())[0]?.status).toBe("running");
    release(); await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    expect(dispatch.mock.calls.map((call) => call[0].id)).toEqual(["planner", "worker"]); expect(runner.isActive(run.id)).toBe(false);
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

  it("persists partial cancellation failures for the user", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-cancel-error-")); const store = new HarnessStore("/workspace", state);
    await store.saveRun({ id: "active", harnessId: "flow", harnessVersion: 1, input: "task", status: "running", createdAt: "now", blocks: [{ blockId: "left", status: "running", provider: "codex" }, { blockId: "right", status: "running", provider: "claude" }] });
    const cancelled = await new HarnessRunner(store, () => undefined).cancel("active", async (provider) => { if (provider === "claude") throw new Error("provider offline"); });
    expect(cancelled.cleanupErrors).toEqual(["Could not stop block right: provider offline"]);
    expect((await store.runs())[0]?.cleanupErrors).toEqual(cancelled.cleanupErrors);
  });

  it("keeps cancellation terminal when a provider completes during cleanup", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-cancel-race-")); const store = new HarnessStore("/workspace", state);
    const definition = await store.create("Cancellation race");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined); const run = await runner.start(definition.id, "work", async () => { await waiting; return session("late-success"); });
    await vi.waitFor(async () => expect((await store.runs())[0]?.blocks[0]?.status).toBe("running"));

    await runner.cancel(run.id, async () => release());
    await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(false));

    const cancelled = (await store.runs())[0]!;
    expect(cancelled).toMatchObject({ status: "cancelled", blocks: [{ status: "cancelled" }] });
    expect(cancelled.blocks[0]?.output).toBeUndefined();
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

  it("shares one concurrency limit between graph dispatch and asynchronous stack launches", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-scheduler-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Shared scheduler");
    const blocks: HarnessBlock[] = ["root", "left", "right"].map((id) => ({ id, type: "prompt", label: id, prompt: "{{input}}", position: { x: 0, y: 0 } }));
    await store.update({ ...definition, blocks, edges: [{ id: "left", from: "root", to: "left", execution: "async" }, { id: "right", from: "root", to: "right", execution: "async" }] });
    const runner = new HarnessRunner(store, () => undefined, 1); let active = 0; let maxActive = 0;
    const dispatch = vi.fn(async (block: HarnessBlock, _prompt: string, runtime: { runId: string; blockId: string }) => {
      active += 1; maxActive = Math.max(maxActive, active);
      if (block.id === "root") await runner.runStack(runtime.runId, runtime.blockId, ["downstream"]);
      else await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1; return session(block.id);
    });
    await runner.start(definition.id, "go", dispatch, "test");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    expect(maxActive).toBe(1); expect(dispatch.mock.calls.map((call) => call[0].id).sort()).toEqual(["left", "right", "root"]);
  });

  it("serializes hot input with the active block session and tracks it through completion", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-hot-input-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Hot input");
    await store.update({ ...definition, blocks: [{ id: "root", type: "prompt", label: "root", prompt: "{{input}}", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let active = 0; let maxActive = 0; const runner = new HarnessRunner(store, () => undefined, 1);
    const run = await runner.start(definition.id, "initial", async (_block, _prompt, runtime) => { active += 1; maxActive = Math.max(maxActive, active); await runtime.started("/session/root"); started(); await waiting; active -= 1; return session("initial"); }, "test", async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; return session("appended"); });
    await ready; await runner.appendInput(run.id, "follow-up"); release();
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    const completed = (await store.runs())[0]!; expect(maxActive).toBe(1); expect(completed.blocks[0]?.output).toBe("appended");
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
    const events: string[] = []; const dispatch = vi.fn(async (block: HarnessBlock, prompt: string) => { events.push(`${block.id}-start`); if (block.id === "slow") await new Promise((resolve) => setTimeout(resolve, 150)); if (block.id === "fast") await new Promise((resolve) => setTimeout(resolve, 5)); events.push(`${block.id}-done`); return { id: block.id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: block.id, role: "assistant" as const, text: block.id, timestamp: "now" }] }; });
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

  it("resolves a permission only for its exact paused workflow attempt", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-permission-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Permission");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async (_block, _prompt, runtime) => {
      await runtime.started("/workflow/worker");
      await runtime.activity({ id: "session-1", model: "test", reasoning: "low", status: "in_progress", pendingPermission: { id: "permission-1", title: "Run command", toolCallId: "tool-1", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, messages: [] });
      await waiting; return session("session-1");
    });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_permission"));
    const pauseId = (await store.runs())[0]!.blocks[0]!.pauseId!;
    await expect(runner.resolvePermission(run.id, "worker", "wrong-session", pauseId, "permission-1", "allow", vi.fn())).rejects.toThrow("different workflow session");
    const resolve = vi.fn(async () => ({ id: "session-1", model: "test", reasoning: "low", status: "in_progress" as const, messages: [] }));
    const resumed = await runner.resolvePermission(run.id, "worker", "session-1", pauseId, "permission-1", "allow", resolve);
    expect(resolve).toHaveBeenCalledWith("codex", "/workflow/worker", "permission-1", "allow");
    expect(resumed.status).toBe("running"); expect(resumed.blocks[0]).toMatchObject({ status: "running", sessionId: "session-1" }); expect(resumed.blocks[0]?.pendingPermission).toBeUndefined();
    release(); await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
  });

  it("delivers an answer to the exact workflow session and records it", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-question-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Question");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async (_block, _prompt, runtime) => {
      await runtime.started("/workflow/worker");
      await runtime.activity({ id: "session-2", model: "test", reasoning: "low", status: "user_prompt", messages: [{ id: "question", role: "assistant", text: "Which branch?", timestamp: "now" }] });
      await waiting; return session("session-2");
    });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_user_input"));
    const pauseId = (await store.runs())[0]!.blocks[0]!.pauseId!;
    const answer = vi.fn(async () => ({ id: "session-2", model: "test", reasoning: "low", status: "in_progress" as const, messages: [] }));
    const resumed = await runner.answerQuestion(run.id, "worker", "session-2", pauseId, " feature/auth ", answer);
    expect(answer).toHaveBeenCalledWith("codex", "/workflow/worker", "feature/auth");
    expect(resumed.blocks[0]?.log?.at(-1)?.message).toBe("Provider resumed work");
    expect(resumed.blocks[0]?.log?.some((entry) => entry.message === "User answer: feature/auth")).toBe(true);
    release(); await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
  });

  it("fires the timer for the exact paused attempt", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-timer-resume-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Timer");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async (_block, _prompt, runtime) => {
      await runtime.started("/workflow/worker"); await runtime.activity({ id: "session-timer", model: "test", reasoning: "low", status: "done", messages: [] }, "2099-01-01T00:00:00.000Z");
      await waiting; return session("session-timer");
    });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("waiting_timer"));
    const pauseId = (await store.runs())[0]!.blocks[0]!.pauseId!; const fire = vi.fn().mockResolvedValue(true);
    await expect(runner.resumeTimer(run.id, "worker", "stale-pause", fire)).rejects.toThrow("different paused attempt");
    const resumed = await runner.resumeTimer(run.id, "worker", pauseId, fire);
    expect(fire).toHaveBeenCalledWith("codex", "/workflow/worker"); expect(resumed).toMatchObject({ status: "running", blocks: [{ status: "running", pauseId: undefined }] });
    release(); await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
  });

  it("retries the exact scheduled attempt immediately", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-retry-now-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Retry");
    await store.update({ ...definition, blocks: [{ id: "watchdog", type: "prompt", label: "Watchdog", prompt: "watch", watchdog: true, position: { x: 0, y: 0 } }, { id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); let attempts = 0; const runner = new HarnessRunner(store, () => undefined, 4, { maxAttempts: 3, transportBackoffMs: 60_000 });
    const run = await runner.start(definition.id, "work", async (block) => { if (block.watchdog) { await waiting; return session("watchdog"); } attempts += 1; throw new Error("ETIMEDOUT"); });
    try {
      await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((item) => item.blockId === "worker")?.status).toBe("retry_scheduled"));
      const pauseId = (await store.runs())[0]!.blocks.find((item) => item.blockId === "worker")!.pauseId!;
      await expect(runner.retryPause(run.id, "worker", "stale-pause")).rejects.toThrow("different paused attempt");
      await runner.retryPause(run.id, "worker", pauseId); await vi.waitFor(() => expect(attempts).toBe(2));
    } finally { await runner.cancel(run.id, async () => release()); release(); }
  });

  it("cancels and interrupts a provider-backed paused attempt", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-pause-cancel-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Cancel pause");
    await store.update({ ...definition, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "work", position: { x: 0, y: 0 } }], edges: [] });
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); const runner = new HarnessRunner(store, () => undefined);
    const run = await runner.start(definition.id, "work", async (_block, _prompt, runtime) => {
      await runtime.started("/workflow/worker"); await runtime.activity({ id: "session-cancel", model: "test", reasoning: "low", status: "user_prompt", messages: [{ id: "q", role: "assistant", text: "Continue?", timestamp: "now" }] });
      await waiting; return session("session-cancel");
    });
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_user_input"));
    const pauseId = (await store.runs())[0]!.blocks[0]!.pauseId!; const interrupt = vi.fn(async () => release());
    const cancelled = await runner.cancelPause(run.id, "worker", pauseId, interrupt);
    expect(cancelled.status).toBe("cancelled"); expect(interrupt).toHaveBeenCalledWith("codex", { runId: run.id, blockId: "worker", workspace: "/workflow/worker" });
  });
});

function session(id: string) { return { id, model: "test", reasoning: "low", status: "done" as const, messages: [{ id, role: "assistant" as const, text: id, timestamp: "now" }] }; }
