import crypto from "node:crypto";
import type { HarnessBlock, HarnessBlockAttempt, HarnessBlockIteration, HarnessEdge, HarnessRun, HarnessLogEntry, HarnessChildTask, HarnessFailureReason, HarnessPauseStatus, HarnessOperation, HarnessOperationKind, AiSession } from "@remote-ide/protocol";
import { AiProviderError, normalizeAiFailure, type AiFailure } from "@remote-ide/acp";
import { CoreError } from "./errors.js";
import { HarnessSchemaError, parseHarnessData, validateHarness, renderHarnessPrompt } from "./harness-graph.js";
import type { HarnessStore } from "./harnesses.js";
import type { AiUsage } from "@remote-ide/acp";

type Dispatch = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; iteration: number; started(workspace: string): Promise<void>; activity(session: AiSession, waitingUntil?: string): Promise<void>; assertActive(): void }) => Promise<AiSession>;
type Append = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; workspace: string }) => Promise<AiSession>;
type Interrupt = (provider: string, context: { runId: string; blockId: string; workspace?: string }) => Promise<void>;
type ResolvePermission = (provider: string, workspace: string, requestId: string, optionId?: string) => Promise<AiSession>;
type AnswerQuestion = (provider: string, workspace: string, input: string) => Promise<AiSession>;
type FireTimer = (provider: string, workspace: string) => Promise<boolean>;
type ActiveExecution = { run: HarnessRun; blocks: HarnessBlock[]; edges: HarnessEdge[]; outputs: Map<string, string>; dispatch: Dispatch; append: Append; defaultProvider: string; background: Set<Promise<void>>; stackInvocations: Map<string, number>; turnClaims: Map<string, string>; scheduler: ExecutionScheduler };
type RecoveryPolicy = { maxAttempts: number; transportBackoffMs: number; maxElapsedMs?: number; jitterRatio?: number; random?: () => number };
type ResolvedRecoveryPolicy = Required<RecoveryPolicy>;
export type HarnessRecoveryInspector = {
  session(provider: string, workspace: string): Promise<AiSession | undefined>;
  timer(runId: string, blockId: string, provider: string, workspace: string): Promise<boolean>;
  child?(child: HarnessChildTask): Promise<boolean>;
};

export class HarnessRunner {
  private readonly cancelled = new Set<string>();
  private readonly activeRuns = new Set<string>();
  private readonly activeProviders = new Map<string, Set<string>>();
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly resolvingPauses = new Set<string>();
  private readonly operationsInFlight = new Map<string, Promise<unknown>>();
  private updateQueue = Promise.resolve();
  private readonly recovery: ResolvedRecoveryPolicy;
  constructor(private readonly store: HarnessStore, private readonly changed: (runId: string) => void, private readonly concurrency = 4, recovery: RecoveryPolicy = { maxAttempts: 3, transportBackoffMs: 5_000 }) {
    this.recovery = { maxElapsedMs: 15 * 60_000, jitterRatio: 0.2, random: Math.random, ...recovery };
  }

  isActive(runId: string): boolean { return this.activeRuns.has(runId) && !this.cancelled.has(runId); }

  async registerChild(runId: string, child: Omit<HarnessChildTask, "recoveryAttempts">): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) throw new Error("Workflow is no longer active");
    execution.run.children ??= [];
    if (!execution.run.children.some((item) => item.taskId === child.taskId && item.provider === child.provider)) execution.run.children.push({ ...child, recoveryAttempts: 0 });
    await this.recordCompletedOperation(execution.run, "child_registration", `child:${child.taskId}:${child.provider}`, child.blockId, { taskId: child.taskId, provider: child.provider, workspace: child.workspace });
    await this.update(execution.run);
  }

  async runOperation<T>(runId: string, blockId: string, kind: HarnessOperationKind, idempotencyKey: string, input: unknown, effect: () => Promise<T>, reconcile?: () => Promise<T | null | undefined>): Promise<T> {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) throw new Error("Workflow is no longer active");
    const key = `${blockId}:${idempotencyKey}`; const localKey = `${runId}:${key}`;
    const existing = execution.run.operations?.find((operation) => operation.idempotencyKey === key);
    if (existing?.status === "succeeded") return structuredClone(existing.result) as T;
    const inFlight = this.operationsInFlight.get(localKey); if (inFlight) return await inFlight as T;
    const work = (async () => {
      if (existing?.status === "intent") {
        const recovered = await reconcile?.();
        this.assertActive(runId);
        if (recovered === undefined) throw new CoreError("INVALID_REQUEST", `Operation '${idempotencyKey}' has an unresolved outcome; recovery must reconcile it before retrying`);
        // null means reconciliation proved that the external effect never began,
        // so replay is safe. undefined deliberately preserves the blocked intent.
        if (recovered !== null) { await this.finishOperation(execution.run, existing, "succeeded", recovered); return recovered; }
      }
      const operation = existing ?? await this.beginOperation(execution.run, kind, key, blockId, input);
      if (existing) { operation.status = "intent"; operation.error = undefined; operation.result = undefined; operation.input = journalValue(input); operation.updatedAt = new Date().toISOString(); await this.update(execution.run); }
      let result: T;
      try { this.assertActive(runId); result = await effect(); this.assertActive(runId); }
      catch (error) { operation.error = (error instanceof Error ? error.message : String(error)).slice(-20_000); operation.updatedAt = new Date().toISOString(); await this.update(execution.run); throw error; }
      await this.finishOperation(execution.run, operation, "succeeded", result); return result;
    })();
    this.operationsInFlight.set(localKey, work);
    try { return await work; } finally { if (this.operationsInFlight.get(localKey) === work) this.operationsInFlight.delete(localKey); }
  }

  async runTimerOperation<T>(runId: string, blockId: string, idempotencyKey: string, input: unknown, effect: () => Promise<T>, reconcile?: () => Promise<T | null | undefined>): Promise<T> {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) throw new Error("Workflow is no longer active");
    return execution.scheduler.control(blockId, () => this.runOperation(runId, blockId, "timer_fire", idempotencyKey, input, effect, reconcile));
  }

  async recordTool(runId: string, blockId: string, name: string, args: Record<string, unknown>, result?: unknown, error?: unknown): Promise<void> {
    const execution = this.executions.get(runId); if (!execution) return;
    const key = `tool:${name}:${crypto.randomUUID()}`; const operation = await this.beginOperation(execution.run, "tool_command", key, blockId, { name, args });
    await this.finishOperation(execution.run, operation, error === undefined ? "succeeded" : "failed", result, error);
  }

  async recoverChildren(runId: string, inspect: (child: HarnessChildTask) => Promise<AiSession | undefined>, resume: (child: HarnessChildTask, session: AiSession) => Promise<unknown>): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) return;
    for (const child of execution.run.children ?? []) {
      if (!this.isActive(runId)) return;
      const state = execution.run.blocks.find((block) => block.blockId === child.blockId)!;
      try {
        this.assertActive(runId);
        const session = await inspect(child);
        this.assertActive(runId);
        if (!session || session.status !== "error" || child.recoveryAttempts >= this.recovery.maxAttempts) continue;
        const fallback = session.messages.filter((message) => message.role === "error" || message.role === "assistant").slice(-2).map((message) => message.text).join("\n");
        child.failureReason = classifyWorkflowFailure(session.failure ?? fallback);
        child.retryStartedAt ??= new Date().toISOString();
        if (!isRetryableFailure(child.failureReason) || !retryDue(child.retryAt) || retryBudgetExhausted(child.retryStartedAt, this.recovery) || !this.isActive(runId)) continue;
        child.recoveryAttempts += 1; child.recoveryError = undefined; child.retryAt = undefined;
        this.log(state, "lifecycle", `Resuming child ${child.taskId} after ${child.failureReason}, attempt ${child.recoveryAttempts}/${this.recovery.maxAttempts}`);
        await this.update(execution.run);
        this.assertActive(runId);
        await resume(child, session);
        this.assertActive(runId);
      } catch (error) {
        if (error instanceof Cancelled) return;
        child.recoveryError = error instanceof Error ? error.message : String(error);
        child.failureReason = classifyWorkflowFailure(error);
        child.retryAt = nextRetryAt(child.failureReason, child.recoveryAttempts, this.recovery, child.retryStartedAt);
        this.log(state, "error", `Child ${child.taskId} recovery: ${child.recoveryError}`);
      }
      await this.update(execution.run);
    }
  }

  async watch(runId: string, blockId: string, usage: () => Promise<AiUsage>, recoverChildren: () => Promise<void> = async () => undefined): Promise<AiSession> {
    const execution = this.executions.get(runId);
    const state = execution?.run.blocks.find((item) => item.blockId === blockId);
    if (!execution || !state) throw new Error("Workflow is no longer active");
    this.log(state, "lifecycle", "Core watchdog started; no AI session or model tokens required");
    while (this.isActive(runId) && !this.deliveryIsTerminal(execution)) {
      const snapshot = await usage().catch(() => undefined);
      if (!this.isActive(runId)) break;
      if (this.deliveryIsTerminal(execution)) break;
      state.waitingUntil = nextWatchdogReset(snapshot);
      this.log(state, "lifecycle", `Core watchdog sleeping until ${state.waitingUntil}`);
      await this.update(execution.run);
      while (this.isActive(runId) && !this.deliveryIsTerminal(execution) && Date.now() < Date.parse(state.waitingUntil)) await new Promise((resolve) => setTimeout(resolve, 250));
      if (!this.isActive(runId)) break;
      if (this.deliveryIsTerminal(execution)) break;
      await recoverChildren();
      if (!this.isActive(runId)) break;
      const { resumed } = await this.resumeFailed(runId, blockId);
      this.log(state, "lifecycle", `Core watchdog woke; queued ${resumed.length} eligible failed stages`);
      state.waitingUntil = undefined;
      await this.update(execution.run);
    }
    if (this.isActive(runId) && this.deliveryIsTerminal(execution)) {
      state.waitingUntil = undefined;
      this.log(state, "lifecycle", "Core watchdog stopped because delivery reached a terminal state");
      await this.update(execution.run);
      return { model: "core", reasoning: "none", status: "done", messages: [] };
    }
    throw new Cancelled();
  }

  async start(harnessId: string, input: string, dispatch: Dispatch, defaultProvider = "codex", append?: Append): Promise<HarnessRun> {
    if (!input.trim() || input.length > 100_000) throw new CoreError("INVALID_REQUEST", "Harness input must contain 1–100,000 characters");
    const harness = await this.store.read(harnessId); const validation = validateHarness(harness);
    if (!validation.valid) throw new CoreError("INVALID_REQUEST", validation.issues.map((issue) => issue.message).join("; "));
    const createdAt = new Date().toISOString();
    const run: HarnessRun = { id: crypto.randomUUID(), harnessId, harnessVersion: harness.version, input: input.trim(), status: "queued", createdAt, blocks: validation.order.map((blockId) => ({ blockId, status: "queued" })), operations: [] };
    run.definition = structuredClone(harness);
    run.executionPlan = { version: 1, createdAt, definitionVersion: harness.version, order: [...validation.order], blocks: validation.order.map((blockId) => ({ blockId, incoming: harness.edges.filter((edge) => edge.to === blockId).map((edge) => edge.id), outgoing: harness.edges.filter((edge) => edge.from === blockId).map((edge) => edge.id) })) };
    await this.store.saveRun(run); this.changed(run.id);
    this.activeRuns.add(run.id); void this.execute(run, harness.blocks, harness.edges, validation.order, dispatch, defaultProvider, append ?? (async () => { throw new Error("This workflow runtime cannot append to an active block session"); }));
    return run;
  }

  async recover(dispatch: Dispatch, defaultProvider = "codex", append?: Append, inspector?: HarnessRecoveryInspector): Promise<HarnessRun[]> {
    const recovered: HarnessRun[] = [];
    for (const run of await this.store.runs()) {
      if (!isActiveStatus(run.status)) continue;
      const definition = run.definition;
      const validation = definition ? validateHarness(definition) : undefined;
      if (!definition || !run.executionPlan || !validation?.valid || run.executionPlan.definitionVersion !== run.harnessVersion) {
        await this.failRecovery(run, "The persisted workflow has no valid frozen execution plan. Start a new run; completed sessions and task workspaces were preserved.");
        recovered.push(structuredClone(run)); continue;
      }
      const order = run.executionPlan.order;
      if (order.length !== definition.blocks.length || order.some((id) => !definition.blocks.some((block) => block.id === id))) {
        await this.failRecovery(run, "The persisted workflow execution plan does not match its frozen definition. Start a new run; completed sessions and task workspaces were preserved.");
        recovered.push(structuredClone(run)); continue;
      }
      this.activeRuns.add(run.id);
      try {
        await this.reconcilePersistedRun(run, inspector);
        recovered.push(structuredClone(run));
        void this.execute(run, definition.blocks, definition.edges, order, dispatch, defaultProvider, append ?? (async () => { throw new Error("This workflow runtime cannot append to an active block session"); }), true);
      } catch (error) {
        this.activeRuns.delete(run.id);
        await this.failRecovery(run, `Workflow recovery could not inspect its persisted resources: ${error instanceof Error ? error.message : String(error)}`);
        recovered.push(structuredClone(run));
      }
    }
    return recovered;
  }

  async cancel(runId: string, interrupt: Interrupt): Promise<HarnessRun> {
    const persisted = (await this.store.runs()).find((item) => item.id === runId);
    const execution = this.executions.get(runId); const run = execution?.run ?? persisted;
    if (!run) throw new CoreError("FILE_NOT_FOUND", "Harness run does not exist");
    if (!isActiveStatus(run.status)) return run;
    if (this.activeRuns.has(runId)) this.cancelled.add(runId);
    const active = run.blocks.filter((block) => providerActiveStatuses.has(block.status) && block.provider);
    const completedAt = new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
    for (const block of run.blocks) if (isActiveStatus(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
    run.cleanupErrors = undefined; await this.recordCompletedOperation(run, "terminal_outcome", "terminal:cancelled", undefined, { status: "cancelled", completedAt }); await this.update(run);
    const targets = [
      ...active.map((block) => ({ label: `block ${block.blockId}`, provider: block.provider!, context: { runId, blockId: block.blockId, workspace: block.workspace } })),
      ...(run.children ?? []).map((child) => ({ label: `child task ${child.taskId}`, provider: child.provider, context: { runId, blockId: child.blockId, workspace: child.workspace } }))
    ];
    const cleanup = await Promise.allSettled(targets.map((target) => interrupt(target.provider, target.context)));
    run.cleanupErrors = cleanup.flatMap((result, index) => result.status === "rejected" ? [`Could not stop ${targets[index]!.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (!run.cleanupErrors.length) run.cleanupErrors = undefined;
    else await this.update(run);
    return run;
  }

  async appendInput(runId: string, input: string): Promise<HarnessRun> {
    const value = input.trim(); if (!value || value.length > 100_000) throw new CoreError("INVALID_REQUEST", "Workflow input must contain 1–100,000 characters");
    const execution = this.executions.get(runId); if (!execution || !this.isActive(runId)) throw new CoreError("INVALID_REQUEST", "Workflow run is no longer active");
    const targets = execution.blocks.filter((block) => !execution.edges.some((edge) => edge.to === block.id && !edge.loop));
    const available = targets.filter((block) => { const state = execution.run.blocks.find((item) => item.blockId === block.id); return state?.workspace && state.status === "running"; });
    if (!available.length) throw new CoreError("INVALID_REQUEST", "The workflow dispatcher session is not ready for another prompt");
    for (const block of available) { const state = execution.run.blocks.find((item) => item.blockId === block.id)!; state.status = "running"; state.completedAt = undefined; state.prompt = value; }
    await this.update(execution.run);
    let task!: Promise<void>;
    task = Promise.all(available.map((block) => execution.scheduler.turn(block.id, async () => {
      const state = execution.run.blocks.find((item) => item.blockId === block.id)!;
      const claim = crypto.randomUUID(); execution.turnClaims.set(block.id, claim);
      this.assertActive(runId);
      const session = await execution.append(block, value, { runId, blockId: block.id, workspace: state.workspace! });
      this.assertActive(runId);
      if (execution.turnClaims.get(block.id) !== claim) return;
      const output = session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
      state.sessionId = session.id; state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(block.id, output);
      await this.update(execution.run);
    }))).then(() => undefined).catch(async (error) => { if (error instanceof Cancelled || this.cancelled.has(runId)) return; execution.run.status = "failed"; execution.run.error = error instanceof Error ? error.message : String(error); execution.run.completedAt = new Date().toISOString(); await this.update(execution.run); }).finally(() => execution.background.delete(task));
    execution.background.add(task);
    return structuredClone(execution.run);
  }

  async resolvePermission(runId: string, blockId: string, sessionId: string, pauseId: string, requestId: string, optionId: string | undefined, resolve: ResolvePermission): Promise<HarnessRun> {
    const { execution, state, provider, workspace } = this.pausedAttempt(runId, blockId, pauseId, "awaiting_permission", sessionId);
    if (state.pendingPermission?.id !== requestId) throw new CoreError("INVALID_REQUEST", "Permission request is no longer pending");
    if (optionId && !state.pendingPermission.options.some((option) => option.optionId === optionId)) throw new CoreError("INVALID_REQUEST", "Unknown permission option");
    const key = `${runId}:${blockId}:${sessionId}:${requestId}`;
    if (this.resolvingPauses.has(key)) throw new CoreError("INVALID_REQUEST", "Permission request is already being resolved");
    this.resolvingPauses.add(key);
    try {
      this.assertActive(runId);
      const session = await execution.scheduler.control(blockId, () => resolve(provider, workspace, requestId, optionId));
      this.assertActive(runId);
      await this.recordActivity(execution.run, state, session);
      return structuredClone(execution.run);
    } finally { this.resolvingPauses.delete(key); }
  }

  async answerQuestion(runId: string, blockId: string, sessionId: string, pauseId: string, input: string, answer: AnswerQuestion): Promise<HarnessRun> {
    const value = input.trim();
    if (!value || value.length > 100_000) throw new CoreError("INVALID_REQUEST", "Workflow answer must contain 1–100,000 characters");
    const { execution, state, provider, workspace } = this.pausedAttempt(runId, blockId, pauseId, "awaiting_user_input", sessionId);
    const key = `${runId}:${blockId}:${sessionId}:answer`;
    if (this.resolvingPauses.has(key)) throw new CoreError("INVALID_REQUEST", "An answer is already being delivered");
    this.resolvingPauses.add(key);
    try {
      this.assertActive(runId);
      const session = await execution.scheduler.control(blockId, () => answer(provider, workspace, value));
      this.assertActive(runId);
      this.log(state, "prompt", `User answer: ${value}`);
      await this.recordActivity(execution.run, state, session);
      return structuredClone(execution.run);
    } finally { this.resolvingPauses.delete(key); }
  }

  async resumeTimer(runId: string, blockId: string, pauseId: string, fire: FireTimer): Promise<HarnessRun> {
    const { execution, state, provider, workspace } = this.pausedAttempt(runId, blockId, pauseId, "waiting_timer");
    const key = `${runId}:${blockId}:${pauseId}:resume`;
    if (this.resolvingPauses.has(key)) throw new CoreError("INVALID_REQUEST", "Timer is already being resumed");
    this.resolvingPauses.add(key);
    try {
      this.assertActive(runId);
      const fired = await this.runOperation(runId, blockId, "timer_fire", `timer-fire:${pauseId}`, { workspace, provider, pauseId }, () => fire(provider, workspace));
      if (!fired) throw new CoreError("INVALID_REQUEST", "Workflow timer is no longer pending");
      this.assertActive(runId);
      if (state.status === "waiting_timer" && state.pauseId === pauseId) {
        state.status = "running"; state.waitingUntil = undefined; state.pauseId = undefined; execution.run.status = this.runActivityStatus(execution.run);
        this.log(state, "lifecycle", "Timer fired early by user"); await this.update(execution.run);
      }
      return structuredClone(execution.run);
    } finally { this.resolvingPauses.delete(key); }
  }

  async retryPause(runId: string, blockId: string, pauseId: string): Promise<HarnessRun> {
    const { execution, state } = this.pausedAttempt(runId, blockId, pauseId, "retry_scheduled", undefined, false);
    if ((state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts || retryBudgetExhausted(state.retryStartedAt, this.recovery)) throw new CoreError("INVALID_REQUEST", "The automatic retry budget is exhausted");
    state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
    state.status = "queued"; state.error = undefined; state.completedAt = undefined; state.retryAt = undefined; state.pauseId = undefined; execution.run.status = "running";
    this.log(state, "lifecycle", "Retry requested by user"); await this.update(execution.run);
    return structuredClone(execution.run);
  }

  async cancelPause(runId: string, blockId: string, pauseId: string, interrupt: Interrupt): Promise<HarnessRun> {
    this.pausedAttempt(runId, blockId, pauseId, ["awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"], undefined, false);
    return this.cancel(runId, interrupt);
  }

  async resumeFailed(runId: string, callerId: string): Promise<{ resumed: string[] }> {
    const execution = this.executions.get(runId);
    if (!execution || this.cancelled.has(runId)) throw new Error("Workflow is no longer active");
    if (!execution.blocks.find((block) => block.id === callerId)?.watchdog) throw new Error("Only a watchdog can request recovery");
    const resumed: string[] = [];
    for (const state of execution.run.blocks) {
      if (!["failed", "retry_scheduled"].includes(state.status) || state.blockId === callerId) continue;
      state.failureReason ??= classifyWorkflowFailure(state.error ?? "");
      if (!isRetryableFailure(state.failureReason) || !retryDue(state.retryAt) || (state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts) continue;
      if (retryBudgetExhausted(state.retryStartedAt, this.recovery)) {
        state.status = "failed"; state.retryAt = undefined; state.pauseId = undefined;
        state.error = `${state.error ?? "Provider attempt failed"} Automatic retry budget exhausted; retry this block manually after resolving the provider issue.`;
        this.log(state, "error", "Automatic retry budget exhausted");
        continue;
      }
      state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
      state.status = "queued"; state.error = undefined; state.completedAt = undefined; state.retryAt = undefined; state.pauseId = undefined; execution.run.status = "running";
      this.log(state, "lifecycle", `Watchdog requested continuation after ${state.failureReason} (${state.recoveryAttempts}/${this.recovery.maxAttempts})`); resumed.push(state.blockId);
    }
    await this.update(execution.run);
    return { resumed };
  }

  async runStack(runId: string, blockId: string, inputs: string[], path?: string): Promise<{ blocks: Array<{ blockId: string; output: string }> }> {
    const execution = this.executions.get(runId); if (!execution || !this.isActive(runId)) throw new Error("Workflow execution is no longer active");
    if (!inputs.length || !inputs.every((input) => typeof input === "string" && input.trim())) throw new Error("inputs must be a non-empty array of strings");
    const caller = execution.blocks.find((block) => block.id === blockId); const callerState = execution.run.blocks.find((block) => block.blockId === blockId);
    if (!caller || callerState?.status !== "running") throw new Error("Only a currently running workflow block can launch a stack");
    execution.stackInvocations.set(blockId, (execution.stackInvocations.get(blockId) ?? 0) + 1);
    let outgoing = execution.edges.filter((edge) => edge.from === blockId);
    if (path !== undefined) outgoing = outgoing.filter((edge) => edge.label === path);
    if (!outgoing.length) throw new Error(path === undefined ? "This block has no downstream path" : `No downstream path named '${path}'`);
    if (caller.routing === "ai" && path === undefined) throw new Error("path is required because this block uses AI-selected routing");
    if (path !== undefined) { callerState.selectedRoute = path; await this.recordCompletedOperation(execution.run, "route_selection", `route:${blockId}:${callerState.attempts?.at(-1)?.id ?? "initial"}`, blockId, { path }); }
    const targets = outgoing.map((edge) => ({ edge, block: execution.blocks.find((block) => block.id === edge.to)! })).filter((target) => Boolean(target.block));
    const launch = async (target: HarnessBlock, waitForCurrentTurn = false): Promise<void> => {
      this.assertActive(runId);
      const state = execution.run.blocks.find((item) => item.blockId === target.id)!;
      // An async loop may reach a block while its previous invocation is still
      // returning from the tool call that launched the loop. Let that invocation
      // settle first so it cannot overwrite this turn's `running` state.
      while (waitForCurrentTurn && state.status === "running") {
        this.assertActive(runId);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (["queued", "waiting", "skipped"].includes(state.status) && !state.workspace) {
        state.status = "running"; await this.update(execution.run);
        await this.executeBlock(execution.run, target, execution.blocks, execution.edges, execution.outputs, execution.dispatch, execution.defaultProvider, inputs);
        await this.executeRevivedDescendants(execution, target.id); return;
      }
      if (!state.workspace || !["running", "succeeded"].includes(state.status)) throw new Error(`Downstream block '${target.label}' cannot accept another prompt`);
      const invocationCount = execution.stackInvocations.get(target.id) ?? 0;
      const output = await execution.scheduler.nestedTurn(target.id, async () => {
        const claim = crypto.randomUUID(); execution.turnClaims.set(target.id, claim);
        this.assertActive(runId); state.status = "running"; state.completedAt = undefined; await this.update(execution.run);
        const replies: string[] = [];
        for (const input of inputs) { this.assertActive(runId); const session = await execution.append(target, input, { runId, blockId: target.id, workspace: state.workspace! }); this.assertActive(runId); replies.push(session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""); state.sessionId = session.id; }
        const value = replies.length === 1 ? replies[0]! : replies.map((reply, index) => `## Appended prompt ${index + 1}\n${reply}`).join("\n\n");
        if (execution.turnClaims.get(target.id) === claim) { state.output = value.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(target.id, value); await this.update(execution.run); }
        return value;
      });
      const forward = execution.edges.filter((edge) => edge.from === target.id && !edge.loop);
      if (target.routing !== "ai" && forward.length && (execution.stackInvocations.get(target.id) ?? 0) === invocationCount) {
        // Forward graph edges run automatically on the initial pass. Preserve the
        // same contract when a loop appends to an existing session; otherwise a
        // successful repeated block silently terminates unless the model happens
        // to call workflow_run_stack itself.
        state.status = "running"; state.completedAt = undefined; await this.update(execution.run);
        await this.runStack(runId, target.id, [output]);
        state.status = "succeeded"; state.completedAt = new Date().toISOString(); await this.update(execution.run);
      }
    };
    await execution.scheduler.suspend(blockId, async () => {
      for (const target of targets) {
        if ((target.edge.execution ?? "sync") === "sync") { await launch(target.block); continue; }
        let task!: Promise<void>;
        task = launch(target.block, true).catch(async (error) => {
          if (error instanceof Cancelled || this.cancelled.has(runId)) return;
          const state = execution.run.blocks.find((item) => item.blockId === target.block.id)!;
          state.status = "failed"; state.error = error instanceof Error ? error.message : String(error); state.completedAt = new Date().toISOString(); this.log(state, "error", state.error); await this.update(execution.run);
        }).finally(() => execution.background.delete(task));
        execution.background.add(task);
      }
    });
    return { blocks: targets.map((target) => ({ blockId: target.block.id, output: execution.outputs.get(target.block.id) ?? "" })) };
  }

  private async executeRevivedDescendants(execution: ActiveExecution, sourceId: string): Promise<void> {
    const targets = execution.edges.filter((edge) => edge.from === sourceId).map((edge) => execution.blocks.find((block) => block.id === edge.to)).filter((block): block is HarnessBlock => Boolean(block));
    await Promise.all(targets.map(async (target) => {
      this.assertActive(execution.run.id);
      const state = execution.run.blocks.find((item) => item.blockId === target.id)!;
      if (state.status !== "queued" && state.status !== "waiting") return;
      if (blockReadiness(target.id, execution.blocks, execution.edges, execution.run.blocks) !== "ready") return;
      state.status = "running"; await this.update(execution.run);
      await this.executeBlock(execution.run, target, execution.blocks, execution.edges, execution.outputs, execution.dispatch, execution.defaultProvider);
      await this.executeRevivedDescendants(execution, target.id);
    }));
  }

  private async execute(run: HarnessRun, blocks: HarnessBlock[], edges: HarnessEdge[], order: string[], dispatch: Dispatch, defaultProvider: string, append: Append, recovering = false): Promise<void> {
    const outputs = new Map(run.blocks.flatMap((state) => state.status === "succeeded" && state.output !== undefined ? [[state.blockId, state.output] as const] : []));
    run.status = this.runActivityStatus(run); run.startedAt ??= new Date().toISOString(); const background = new Set<Promise<void>>(); this.executions.set(run.id, { run, blocks, edges, outputs, dispatch, append, defaultProvider, background, stackInvocations: new Map(), turnClaims: new Map(), scheduler: new ExecutionScheduler(this.concurrency, () => this.assertActive(run.id)) });
    if (recovering) for (const state of run.blocks) if (isActiveStatus(state.status)) this.log(state, "lifecycle", "Core restarted and reconciled this workflow stage");
    await this.update(run);
    const running = new Map<string, Promise<{ blockId: string; error?: unknown }>>();
    try {
      while (running.size || background.size || run.blocks.some((block) => isActiveStatus(block.status))) {
        if (this.cancelled.has(run.id)) throw new Cancelled();
        let changed = false;
        for (const blockId of order) {
          if (running.size >= this.concurrency) break;
          const state = run.blocks.find((item) => item.blockId === blockId)!;
          if (!["queued", "waiting"].includes(state.status)) continue;
          const readiness = blockReadiness(blockId, blocks, edges, run.blocks);
          if (readiness === "wait") { if (state.status !== "waiting") { state.status = "waiting"; this.log(state, "lifecycle", "Waiting for upstream blocks"); await this.recordCompletedOperation(run, "dependency_decision", `dependency:${blockId}:wait:${state.attempts?.length ?? 0}`, blockId, { decision: "wait" }); changed = true; } continue; }
          if (readiness === "skip") { state.status = "skipped"; state.completedAt = new Date().toISOString(); await this.recordCompletedOperation(run, "dependency_decision", `dependency:${blockId}:skip:${state.attempts?.length ?? 0}`, blockId, { decision: "skip" }); changed = true; continue; }
          await this.recordCompletedOperation(run, "dependency_decision", `dependency:${blockId}:ready:${state.attempts?.length ?? 0}`, blockId, { decision: "ready" });
          const block = blocks.find((item) => item.id === blockId)!; state.status = "running"; changed = true;
          const task = this.executeBlock(run, block, blocks, edges, outputs, dispatch, defaultProvider).then(() => ({ blockId }), async (error) => {
            const failure = workflowFailure(error); const reason = classifyWorkflowFailure(error);
            if (this.cancelled.has(run.id) || (!blocks.some((item) => item.watchdog) && reason !== "schema_validation")) return { blockId, error };
            let message = failure.message;
            state.error = message; state.failureReason = reason;
            if (isRetryableFailure(reason)) state.retryStartedAt ??= new Date().toISOString();
            state.retryAt = nextRetryAt(reason, state.recoveryAttempts ?? 0, this.recovery, state.retryStartedAt, failure.retryAfter);
            const cannotSchedule = reason === "transient_transport" && state.retryAt === undefined;
            const exhausted = cannotSchedule || retryBudgetExhausted(state.retryStartedAt, this.recovery) || (state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts;
            state.status = (isRetryableFailure(reason) && !exhausted) || reason === "schema_validation" ? "retry_scheduled" : "failed";
            if (exhausted && isRetryableFailure(reason)) { message += " Automatic retry budget exhausted; retry this block manually after resolving the provider issue."; state.error = message; }
            state.pauseId = state.status === "retry_scheduled" ? crypto.randomUUID() : undefined;
            run.status = this.runActivityStatus(run);
            this.log(state, "error", message); await this.update(run);
            return { blockId };
          });
          running.set(blockId, task);
        }
        if (changed) await this.update(run);
        if (!running.size) {
          if (background.size) { await Promise.race(background); continue; }
          if (run.blocks.some((block) => pauseStatuses.has(block.status))) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
          if (run.blocks.some((block) => ["queued", "waiting"].includes(block.status))) throw new Error("Harness could not resolve its remaining paths");
          break;
        }
        let tick: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([...running.values(), new Promise<undefined>((resolve) => { tick = setTimeout(() => resolve(undefined), 250); })]);
        if (tick) clearTimeout(tick);
        if (completed) { running.delete(completed.blockId); if (completed.error) throw completed.error; }
      }
      if (this.cancelled.has(run.id)) throw new Cancelled();
      const failed = run.blocks.find((block) => block.status === "failed"); if (failed) throw new Error(failed.error ?? "Asynchronous workflow block failed");
      run.status = "succeeded"; run.completedAt = new Date().toISOString(); await this.recordCompletedOperation(run, "terminal_outcome", `terminal:${run.status}`, undefined, { status: run.status, completedAt: run.completedAt }); await this.update(run);
    } catch (error) {
      const cancelled = error instanceof Cancelled || this.cancelled.has(run.id); run.status = cancelled ? "cancelled" : "failed"; run.error = cancelled ? undefined : error instanceof Error ? error.message : String(error); run.completedAt = new Date().toISOString();
      for (const block of run.blocks) if (isActiveStatus(block.status)) { block.status = cancelled ? "cancelled" : block.status === "running" ? "failed" : "cancelled"; if (block.status === "failed") { block.error = run.error; block.failureReason = classifyWorkflowFailure(error); } }
      await this.recordCompletedOperation(run, "terminal_outcome", `terminal:${run.status}`, undefined, { status: run.status, error: run.error, completedAt: run.completedAt }); await this.update(run);
    } finally {
      await Promise.allSettled([...running.values(), ...background]);
      if (this.cancelled.has(run.id)) {
        const completedAt = run.completedAt ?? new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
        for (const block of run.blocks) if (isActiveStatus(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
        await this.update(run);
      }
      this.cancelled.delete(run.id); this.activeRuns.delete(run.id); this.activeProviders.delete(run.id); this.executions.delete(run.id);
    }
  }

  private async executeBlock(run: HarnessRun, block: HarnessBlock, blocks: HarnessBlock[], edges: HarnessEdge[], outputs: Map<string, string>, dispatch: Dispatch, defaultProvider: string, stack?: string[]): Promise<void> {
    const state = run.blocks.find((item) => item.blockId === block.id)!; const outgoing = edges.filter((edge) => edge.from === block.id);
    const loopOutgoing = outgoing.filter((edge) => edge.loop);
    const blockInput = connectedInput(block.id, run.input, blocks, edges, outputs); const count = stack?.length ?? 1; const collected: string[] = []; let latestAttemptId: string | undefined;
    state.startedAt = new Date().toISOString(); state.provider = block.provider ?? defaultProvider; state.plannedRuns = count; state.iterations = count > 1 ? [] : undefined; state.log = state.log ?? []; this.log(state, "lifecycle", `Started ${count > 1 ? `${count} planned iterations` : "block"}`);
    const providers = this.activeProviders.get(run.id) ?? new Set<string>(); providers.add(state.provider); this.activeProviders.set(run.id, providers); await this.update(run);
    try {
      for (let index = 0; index < count; index += 1) {
        this.assertActive(run.id);
        const input = stack?.[index] ?? blockInput;
        const structuredInput = parseHarnessData(input, block.inputSchema, `${block.label} input`);
        if (structuredInput !== undefined) state.structuredInput = structuredInput;
        let prompt = renderHarnessPrompt(block.prompt, input, outputs).replace(/\{\{\s*iteration\s*\}\}/g, String(index + 1));
        if (index === 0 && state.workspace) prompt = `Continue your interrupted work from this session. Inspect prior tool results and preserve recorded task IDs and completed merges; do not duplicate previously completed operations. Original stage instructions:\n\n${prompt}`;
        if (outgoing.length) prompt += `\n\nWorkflow runtime capability: Use workflow_run_stack to send prompts to directly connected blocks and wait for their replies. If a connected block already has a session, the prompt is appended to that same session. Use timer_set to pause yourself and resume this same session later.`;
        if (loopOutgoing.length) prompt += `\nLoop paths return to earlier workflow blocks for another cycle. Use one only when another pass is needed: ${loopOutgoing.map((edge) => edge.label ?? blocks.find((item) => item.id === edge.to)?.label ?? edge.to).join(", ")}.`;
        if (block.routing === "ai" && outgoing.length) prompt += `\nChoose a named path when calling workflow_run_stack. Available paths: ${outgoing.map((edge) => edge.label).join(", ")}.`;
        if (block.type === "task") prompt += `\n\nThis is a visible task-orchestration block. Create implementation workspaces with task_create_and_start, inspect them with task_list and task_ai_response_tail, append instructions with task_append_prompt, and merge completed work with task_merge.`;
        state.prompt = prompt;
        this.log(state, "prompt", prompt);
        const attemptIndex = (state.attempts?.length ?? 0) + 1; const attemptId = crypto.randomUUID();
        latestAttemptId = attemptId;
        const attemptOperation = await this.beginOperation(run, "block_attempt", `block-attempt:${block.id}:${attemptIndex}`, block.id, { attemptIndex, iteration: index + 1, provider: state.provider }, attemptId);
        const attempt: HarnessBlockAttempt = { id: attemptId, index: attemptIndex, status: "running", startedAt: new Date().toISOString(), operationId: attemptOperation.id };
        state.attempts = [...(state.attempts ?? []), attempt];
        const promptOperation = await this.beginOperation(run, "prompt_delivery", `prompt:${block.id}:${attemptId}`, block.id, { provider: state.provider, prompt }, attemptId);
        const iteration: HarnessBlockIteration | undefined = state.iterations ? { index: index + 1, status: "running", startedAt: new Date().toISOString(), prompt } : undefined; if (iteration) state.iterations!.push(iteration); await this.update(run);
        try {
          const started = async (workspace: string) => { this.assertActive(run.id); state.workspace = workspace; attempt.workspace = workspace; if (iteration) iteration.workspace = workspace; await this.recordCompletedOperation(run, "session_binding", `session-workspace:${attemptId}`, block.id, { workspace }, attemptId); await this.update(run); this.assertActive(run.id); };
          const activity = async (session: AiSession, waitingUntil?: string) => this.recordActivity(run, state, session, waitingUntil);
          const execution = this.executions.get(run.id);
          this.assertActive(run.id);
          if (!execution) throw new Error("Workflow execution is no longer active");
          const settled = await execution.scheduler.turn(block.id, () => {
            execution.turnClaims.set(block.id, attemptId);
            return state.workspace
              ? execution.append(block, prompt, { runId: run.id, blockId: block.id, workspace: state.workspace! })
              : dispatch(block, prompt, { runId: run.id, blockId: block.id, iteration: index + 1, started, activity, assertActive: () => this.assertActive(run.id) });
          });
          this.assertActive(run.id);
          state.sessionId = settled.id; attempt.sessionId = settled.id; if (iteration) iteration.sessionId = settled.id;
          await this.finishOperation(run, promptOperation, "succeeded", { sessionId: settled.id, workspace: state.workspace, status: settled.status });
          await this.recordCompletedOperation(run, "session_binding", `session:${attemptId}`, block.id, { sessionId: settled.id, workspace: state.workspace }, attemptId);
          this.log(state, "response", settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "Provider turn completed without an assistant response");
          if (settled.status === "user_prompt") throw new CoreError("INVALID_REQUEST", `${block.label} requires user input; resume support is not implemented yet`);
          if (settled.status === "error") {
            const message = [settled.messages.filter((message) => message.role === "error").at(-1)?.text ?? `${block.label} failed`, settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""].join("\n");
            throw new AiProviderError(settled.failure ?? normalizeAiFailure(message));
          }
          let output = settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
          const structuredOutput = parseHarnessData(output, block.outputSchema, `${block.label} output`);
          if (structuredOutput !== undefined) state.structuredOutput = structuredOutput;
          collected.push(output); attempt.status = "succeeded"; attempt.completedAt = new Date().toISOString(); await this.finishOperation(run, attemptOperation, "succeeded", { sessionId: settled.id, workspace: state.workspace, output: output.slice(-20_000) }); if (iteration) { iteration.output = output.slice(-200_000); iteration.status = "succeeded"; iteration.completedAt = new Date().toISOString(); } await this.update(run);
        } catch (error) {
          this.log(state, "error", error instanceof Error ? error.message : String(error));
          const message = error instanceof Error ? error.message : String(error); attempt.status = error instanceof Cancelled ? "cancelled" : "failed"; attempt.error = message; attempt.completedAt = new Date().toISOString();
          if (promptOperation.status === "intent") await this.finishOperation(run, promptOperation, "failed", undefined, error);
          if (attemptOperation.status === "intent") await this.finishOperation(run, attemptOperation, "failed", undefined, error);
          if (iteration) { iteration.status = error instanceof Cancelled ? "cancelled" : "failed"; iteration.error = message; iteration.completedAt = new Date().toISOString(); } throw error;
        }
      }
      const output = count === 1 ? collected[0] ?? "" : collected.map((value, index) => `## Stack item ${index + 1}\n${value}`).join("\n\n");
      this.assertActive(run.id);
      const execution = this.executions.get(run.id); if (!execution || execution.turnClaims.get(block.id) !== latestAttemptId) return;
      outputs.set(block.id, output); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); state.failureReason = undefined; state.retryAt = undefined; state.retryStartedAt = undefined; state.waitingUntil = undefined; state.pendingPermission = undefined; state.question = undefined; state.pauseId = undefined; this.log(state, "lifecycle", "Completed successfully"); await this.update(run);
    } finally { const active = this.activeProviders.get(run.id); active?.delete(state.provider); }
  }

  private log(state: HarnessRun["blocks"][number], kind: HarnessLogEntry["kind"], message: string): void {
    const entry: HarnessLogEntry = { timestamp: new Date().toISOString(), kind, message: message.slice(-200_000) };
    state.log = [...(state.log ?? []), entry].slice(-500);
  }

  private async update(run: HarnessRun): Promise<void> {
    const snapshot = structuredClone(run); const next = this.updateQueue.then(async () => { await this.store.saveRun(snapshot); this.changed(run.id); });
    this.updateQueue = next.catch(() => undefined); await next;
  }

  private async beginOperation(run: HarnessRun, kind: HarnessOperationKind, idempotencyKey: string, blockId?: string, input?: unknown, attemptId?: string): Promise<HarnessOperation> {
    const existing = run.operations?.find((operation) => operation.idempotencyKey === idempotencyKey); if (existing) return existing;
    const now = new Date().toISOString(); const operation: HarnessOperation = { id: operationId(run.id, idempotencyKey), idempotencyKey, kind, status: "intent", createdAt: now, updatedAt: now, ...(blockId ? { blockId } : {}), ...(attemptId ? { attemptId } : {}), ...(input === undefined ? {} : { input: journalValue(input) }) };
    run.operations = [...(run.operations ?? []), operation]; await this.update(run); return operation;
  }

  private async finishOperation(run: HarnessRun, operation: HarnessOperation, status: "succeeded" | "failed", result?: unknown, error?: unknown): Promise<void> {
    operation.status = status; operation.updatedAt = new Date().toISOString(); operation.result = result === undefined ? undefined : journalValue(result); operation.error = status === "failed" ? (error instanceof Error ? error.message : String(error)).slice(-20_000) : undefined; await this.update(run);
  }

  private async recordCompletedOperation(run: HarnessRun, kind: HarnessOperationKind, idempotencyKey: string, blockId: string | undefined, result: unknown, attemptId?: string): Promise<void> {
    const existing = run.operations?.find((operation) => operation.idempotencyKey === idempotencyKey);
    if (existing?.status === "succeeded") return;
    if (existing) { await this.finishOperation(run, existing, "succeeded", result); return; }
    const now = new Date().toISOString(); const operation: HarnessOperation = { id: operationId(run.id, idempotencyKey), idempotencyKey, kind, status: "succeeded", createdAt: now, updatedAt: now, result: journalValue(result), ...(blockId ? { blockId } : {}), ...(attemptId ? { attemptId } : {}) };
    run.operations = [...(run.operations ?? []), operation]; await this.update(run);
  }

  private async recordActivity(run: HarnessRun, state: HarnessRun["blocks"][number], session: AiSession, waitingUntil?: string): Promise<void> {
    this.assertActive(run.id);
    const status: "running" | HarnessPauseStatus = session.pendingPermission ? "awaiting_permission" : waitingUntil ? "waiting_timer" : session.status === "user_prompt" ? "awaiting_user_input" : "running";
    const question = status === "awaiting_user_input" ? session.messages.filter((message) => message.role === "assistant").at(-1)?.text : undefined;
    const permission = status === "awaiting_permission" ? session.pendingPermission : undefined;
    const pauseId = status === "running" ? undefined : state.status === status ? state.pauseId ?? crypto.randomUUID() : crypto.randomUUID();
    if (state.status === status && state.waitingUntil === waitingUntil && state.question === question && JSON.stringify(state.pendingPermission) === JSON.stringify(permission) && state.sessionId === session.id && state.pauseId === pauseId) return;
    const previous = state.status; state.status = status; state.sessionId = session.id; state.waitingUntil = waitingUntil; state.question = question; state.pendingPermission = permission;
    const attempt = state.attempts?.at(-1); if (attempt && session.id) { attempt.sessionId = session.id; await this.recordCompletedOperation(run, "session_binding", `session:${attempt.id}`, state.blockId, { sessionId: session.id, workspace: state.workspace }, attempt.id); }
    state.pauseId = pauseId;
    run.status = this.runActivityStatus(run);
    if (previous !== status) this.log(state, "lifecycle", status === "running" ? "Provider resumed work" : `Paused: ${status.replaceAll("_", " ")}`);
    await this.update(run);
  }

  private pausedAttempt(runId: string, blockId: string, pauseId: string, expected: HarnessPauseStatus | HarnessPauseStatus[], sessionId?: string, requireOwnership = true): { execution: ActiveExecution; state: HarnessRun["blocks"][number]; provider: string; workspace: string } {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) throw new CoreError("INVALID_REQUEST", "Workflow run is no longer active");
    const state = execution.run.blocks.find((item) => item.blockId === blockId);
    const statuses = Array.isArray(expected) ? expected : [expected];
    if (!state || !statuses.includes(state.status as HarnessPauseStatus)) throw new CoreError("INVALID_REQUEST", "Workflow block is no longer waiting for this response");
    if (state.pauseId !== pauseId) throw new CoreError("INVALID_REQUEST", "Response belongs to a different paused attempt");
    if (sessionId !== undefined && state.sessionId !== sessionId) throw new CoreError("INVALID_REQUEST", "Response belongs to a different workflow session");
    if (requireOwnership && (!state.provider || !state.workspace)) throw new CoreError("INVALID_REQUEST", "Workflow session ownership is incomplete");
    return { execution, state, provider: state.provider ?? "", workspace: state.workspace ?? "" };
  }

  private runActivityStatus(run: HarnessRun): HarnessRun["status"] {
    for (const status of ["awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"] as const) if (run.blocks.some((block) => block.status === status)) return status;
    return "running";
  }

  private async reconcilePersistedRun(run: HarnessRun, inspector?: HarnessRecoveryInspector): Promise<void> {
    const now = new Date().toISOString();
    for (const child of run.children ?? []) {
      if (!inspector?.child) continue;
      const exists = await inspector.child(child);
      if (!exists) child.recoveryError = `Owned task '${child.taskId}' is missing after Core restart`;
    }
    for (const state of run.blocks) {
      if (!isActiveStatus(state.status) || state.status === "queued" || state.status === "waiting" || state.status === "retry_scheduled") continue;
      const unresolved = run.operations?.filter((operation) => operation.blockId === state.blockId && operation.status === "intent") ?? [];
      if (!state.provider || !state.workspace || !inspector) {
        this.pauseOrphan(state, unresolved.length ? `Core restarted with unresolved ${unresolved.map((operation) => operation.kind).join(", ")} intent; inspect the existing session and choose Resume or Cancel.` : "Core restarted before session ownership was durably recorded; inspect preserved work and choose Resume or Cancel.");
        continue;
      }
      if (state.status === "waiting_timer" && await inspector.timer(run.id, state.blockId, state.provider, state.workspace)) continue;
      const session = await inspector.session(state.provider, state.workspace);
      const ambiguousOperations = unresolved.filter((item) => !["block_attempt", "prompt_delivery", "session_binding"].includes(item.kind));
      if (ambiguousOperations.length) {
        this.pauseOrphan(state, `Core restarted with unresolved ${ambiguousOperations.map((operation) => operation.kind).join(", ")} intent. Inspect the recorded operation and choose Resume or Cancel; recovery will not repeat it automatically.`); continue;
      }
      if (session && (!state.sessionId || state.sessionId === session.id) && session.status === "done") {
        const output = session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? state.output ?? "";
        const block = run.definition?.blocks.find((item) => item.id === state.blockId);
        try {
          const structuredOutput = parseHarnessData(output, block?.outputSchema, `${block?.label ?? state.blockId} output`);
          if (structuredOutput !== undefined) state.structuredOutput = structuredOutput;
        } catch (error) {
          if (!(error instanceof HarnessSchemaError)) throw error;
          state.status = "retry_scheduled"; state.error = error.message; state.failureReason = "schema_validation"; state.pauseId = crypto.randomUUID(); state.waitingUntil = undefined;
          this.log(state, "error", error.message); continue;
        }
        state.sessionId = session.id; state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = now; state.error = undefined; state.failureReason = undefined; state.pauseId = undefined; state.pendingPermission = undefined; state.question = undefined; state.waitingUntil = undefined;
        const attempt = [...(state.attempts ?? [])].reverse().find((item) => item.status === "running");
        if (attempt) { attempt.status = "succeeded"; attempt.completedAt = now; attempt.sessionId = session.id; attempt.workspace ??= state.workspace; const operation = run.operations?.find((item) => item.id === attempt.operationId); if (operation) { operation.status = "succeeded"; operation.updatedAt = now; operation.error = undefined; operation.result = journalValue({ sessionId: session.id, workspace: state.workspace, output: output.slice(-20_000) }); } }
        for (const operation of unresolved.filter((item) => item.kind === "prompt_delivery" || item.kind === "session_binding")) { operation.status = "succeeded"; operation.updatedAt = now; operation.error = undefined; operation.result = journalValue({ sessionId: session.id, workspace: state.workspace, status: session.status }); }
        this.log(state, "lifecycle", "Recovered a provider turn that completed before Core restarted");
        continue;
      }
      if (session && (!state.sessionId || state.sessionId === session.id) && session.pendingPermission) {
        state.status = "awaiting_permission"; state.sessionId = session.id; state.pendingPermission = session.pendingPermission; state.pauseId ??= crypto.randomUUID(); state.failureReason = "permission_required"; continue;
      }
      if (session && (!state.sessionId || state.sessionId === session.id) && session.status === "user_prompt") {
        state.status = "awaiting_user_input"; state.sessionId = session.id; state.question = session.messages.filter((message) => message.role === "assistant").at(-1)?.text; state.pauseId ??= crypto.randomUUID(); state.failureReason = "user_input_required"; continue;
      }
      const detail = !session ? "the recorded provider session no longer exists" : state.sessionId && state.sessionId !== session.id ? "the workspace now belongs to a different provider session" : session.status === "error" ? "the provider session stopped while Core was offline" : "the provider session outcome is still ambiguous";
      this.pauseOrphan(state, `Core restart recovery found that ${detail}. Existing work was preserved; choose Resume to continue in the recorded workspace or Cancel.`);
    }
    run.status = this.runActivityStatus(run); run.completedAt = undefined; run.error = undefined; await this.update(run);
  }

  private pauseOrphan(state: HarnessRun["blocks"][number], message: string): void {
    state.status = "retry_scheduled"; state.error = message; state.failureReason = "recovery_orphaned"; state.retryAt = undefined; state.pauseId = crypto.randomUUID(); state.pendingPermission = undefined; state.question = undefined; state.waitingUntil = undefined; this.log(state, "error", message);
  }

  private async failRecovery(run: HarnessRun, message: string): Promise<void> {
    const now = new Date().toISOString(); run.status = "failed"; run.error = message; run.completedAt = now;
    for (const state of run.blocks) if (isActiveStatus(state.status)) { state.status = state.status === "running" ? "failed" : "cancelled"; state.completedAt = now; if (state.status === "failed") { state.error = message; state.failureReason = "recovery_orphaned"; } }
    await this.recordCompletedOperation(run, "terminal_outcome", "terminal:recovery-orphaned", undefined, { status: run.status, error: message, completedAt: now }); await this.update(run);
  }

  private deliveryIsTerminal(execution: ActiveExecution): boolean {
    return execution.blocks.filter((block) => !block.watchdog).every((block) => {
      const state = execution.run.blocks.find((item) => item.blockId === block.id);
      if (!state) return false;
      if (["succeeded", "skipped", "cancelled"].includes(state.status)) return true;
      if (state.status !== "failed") return false;
      const reason = state.failureReason ?? classifyWorkflowFailure(state.error ?? "");
      return !isRetryableFailure(reason)
        || (state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts
        || retryBudgetExhausted(state.retryStartedAt, this.recovery)
        || (reason === "transient_transport" && state.retryAt === undefined);
    });
  }

  private assertActive(runId: string): void { if (!this.isActive(runId)) throw new Cancelled(); }
}

function blockReadiness(blockId: string, blocks: HarnessBlock[], edges: HarnessEdge[], states: HarnessRun["blocks"]): "ready" | "wait" | "skip" {
  const incoming = edges.filter((edge) => edge.to === blockId && !edge.loop); if (!incoming.length) return "ready";
  const resolved = incoming.map((edge) => {
    const source = blocks.find((block) => block.id === edge.from)!; const state = states.find((item) => item.blockId === edge.from)!;
    if (state.status === "skipped") return "inactive";
    if (state.status !== "succeeded") return "pending";
    return source.routing === "ai" && state.selectedRoute !== edge.label ? "inactive" : "active";
  });
  const join = blocks.find((block) => block.id === blockId)?.join ?? "all";
  if (join === "any" && resolved.includes("active")) return "ready";
  if (resolved.includes("pending")) return "wait";
  if (!resolved.includes("active")) return "skip";
  return "ready";
}

export function connectedInput(blockId: string, harnessInput: string, blocks: HarnessBlock[], edges: HarnessEdge[], outputs: ReadonlyMap<string, string>): string {
  const predecessors = edges.filter((edge) => edge.to === blockId && !edge.loop).map((edge) => edge.from);
  if (!predecessors.length) return harnessInput;
  const available = predecessors.map((id) => ({ id, output: outputs.get(id) })).filter((item): item is { id: string; output: string } => item.output !== undefined);
  if (available.length === 1) return available[0]!.output;
  return available.map(({ id, output }) => `## ${blocks.find((block) => block.id === id)?.label ?? id}\n${output}`).join("\n\n");
}

class ExecutionScheduler {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly serial = new Map<string, Promise<void>>();
  private readonly owners = new Map<string, { permit: boolean }>();

  constructor(private readonly limit: number, private readonly assertActive: () => void) {}

  async turn<T>(blockId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(blockId) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.serial.set(blockId, tail);
    await previous.catch(() => undefined);
    this.assertActive();
    await this.acquire();
    const owner = { permit: true };
    this.owners.set(blockId, owner);
    try {
      this.assertActive();
      return await work();
    } finally {
      if (owner.permit) this.release();
      if (this.owners.get(blockId) === owner) this.owners.delete(blockId);
      unlock();
      if (this.serial.get(blockId) === tail) this.serial.delete(blockId);
    }
  }

  async suspend<T>(blockId: string, work: () => Promise<T>): Promise<T> {
    const owner = this.owners.get(blockId);
    if (!owner?.permit) return work();
    owner.permit = false;
    this.release();
    try { return await work(); }
    finally {
      await this.acquire();
      owner.permit = true;
      this.assertActive();
    }
  }

  async nestedTurn<T>(blockId: string, work: () => Promise<T>): Promise<T> {
    const suspended = this.owners.get(blockId);
    if (!suspended || suspended.permit) return this.turn(blockId, work);
    await this.acquire();
    const owner = { permit: true };
    this.owners.set(blockId, owner);
    try {
      this.assertActive();
      return await work();
    } finally {
      if (owner.permit) this.release();
      if (this.owners.get(blockId) === owner) this.owners.set(blockId, suspended);
    }
  }

  async control<T>(blockId: string, work: () => Promise<T>): Promise<T> {
    const owner = this.owners.get(blockId);
    if (!owner) return this.turn(blockId, work);
    if (!owner.permit) return this.nestedTurn(blockId, work);
    this.assertActive();
    return work();
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.active -= 1;
  }
}

class Cancelled extends Error {}

const activeStatuses = new Set(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
const pauseStatuses = new Set(["awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
const providerActiveStatuses = new Set(["running", "awaiting_permission", "awaiting_user_input", "waiting_timer"]);
function isActiveStatus(status: string): boolean { return activeStatuses.has(status); }

export function isRecoverableWorkflowError(message: string): boolean {
  return isRetryableFailure(classifyWorkflowFailure(message));
}

export function classifyWorkflowFailure(error: unknown): HarnessFailureReason {
  if (error instanceof Cancelled) return "cancelled";
  if (error instanceof HarnessSchemaError) return "schema_validation";
  return workflowFailure(error).kind;
}

function workflowFailure(error: unknown): AiFailure {
  if (error instanceof Cancelled) return { kind: "cancelled", message: error.message || "Workflow cancelled" };
  if (error instanceof HarnessSchemaError) return { kind: "permanent", message: error.message };
  if (error instanceof AiProviderError) return (error as AiProviderError).failure;
  if (isAiFailure(error)) return error;
  return normalizeAiFailure(error);
}

function isAiFailure(value: unknown): value is AiFailure {
  return Boolean(value && typeof value === "object" && "kind" in value && "message" in value);
}

function isRetryableFailure(reason: HarnessFailureReason): boolean { return reason === "quota_exhausted" || reason === "transient_transport"; }
function retryDue(value?: string): boolean { return value === undefined || Date.parse(value) <= Date.now(); }
function nextRetryAt(reason: HarnessFailureReason, attempts: number, policy: ResolvedRecoveryPolicy, startedAt?: string, providerRetryAfter?: string): string | undefined {
  if (providerRetryAfter && Date.parse(providerRetryAfter) > Date.now()) return withinRetryBudget(providerRetryAfter, startedAt, policy) ? providerRetryAfter : undefined;
  if (reason !== "transient_transport") return undefined;
  const base = policy.transportBackoffMs * 2 ** attempts;
  const jitter = base * policy.jitterRatio * (policy.random() * 2 - 1);
  const value = new Date(Date.now() + Math.max(0, base + jitter)).toISOString();
  return withinRetryBudget(value, startedAt, policy) ? value : undefined;
}

function retryBudgetExhausted(startedAt: string | undefined, policy: ResolvedRecoveryPolicy): boolean {
  return startedAt !== undefined && Date.now() - Date.parse(startedAt) >= policy.maxElapsedMs;
}

function withinRetryBudget(value: string, startedAt: string | undefined, policy: ResolvedRecoveryPolicy): boolean {
  return startedAt === undefined || Date.parse(value) - Date.parse(startedAt) <= policy.maxElapsedMs;
}

function operationId(runId: string, idempotencyKey: string): string { return crypto.createHash("sha256").update(`${runId}\0${idempotencyKey}`).digest("hex").slice(0, 32); }

function journalValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  if (serialized.length <= 50_000) return JSON.parse(serialized) as unknown;
  return { truncated: true, bytes: Buffer.byteLength(serialized), preview: serialized.slice(0, 49_000) };
}

export function nextWatchdogReset(usage?: AiUsage, now = Date.now()): string {
  const windows = [usage?.accountQuota?.primary, usage?.accountQuota?.secondary].filter((window) => window !== undefined);
  const exhausted = windows.filter((window) => window.remainingPercent <= 0 || window.usedPercent >= 100);
  const candidates = (exhausted.length ? exhausted : windows).map((window) => Date.parse(window.resetsAt ?? "")).filter((time) => Number.isFinite(time) && time > now);
  if (exhausted.length && candidates.length !== exhausted.length) return new Date(now + 300_000).toISOString();
  const topLevel = Date.parse(usage?.resetsAt ?? "");
  if (!windows.length && topLevel > now) candidates.push(topLevel);
  return new Date(candidates.length ? (exhausted.length ? Math.max(...candidates) : Math.min(...candidates)) : now + 300_000).toISOString();
}
