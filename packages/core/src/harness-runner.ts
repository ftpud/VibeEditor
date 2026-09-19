import crypto from "node:crypto";
import type { HarnessBlock, HarnessBlockIteration, HarnessEdge, HarnessRun, HarnessLogEntry, HarnessChildTask, HarnessFailureReason, AiSession } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { validateHarness, renderHarnessPrompt } from "./harness-graph.js";
import type { HarnessStore } from "./harnesses.js";
import type { AiUsage } from "@remote-ide/acp";

type Dispatch = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; iteration: number; started(workspace: string): Promise<void>; assertActive(): void }) => Promise<AiSession>;
type Append = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; workspace: string }) => Promise<AiSession>;
type Interrupt = (provider: string, context: { runId: string; blockId: string; workspace?: string }) => Promise<void>;
type ActiveExecution = { run: HarnessRun; blocks: HarnessBlock[]; edges: HarnessEdge[]; outputs: Map<string, string>; dispatch: Dispatch; append: Append; defaultProvider: string; background: Set<Promise<void>> };
type RecoveryPolicy = { maxAttempts: number; transportBackoffMs: number };

export class HarnessRunner {
  private readonly cancelled = new Set<string>();
  private readonly activeRuns = new Set<string>();
  private readonly activeProviders = new Map<string, Set<string>>();
  private readonly executions = new Map<string, ActiveExecution>();
  private updateQueue = Promise.resolve();
  constructor(private readonly store: HarnessStore, private readonly changed: (runId: string) => void, private readonly concurrency = 4, private readonly recovery: RecoveryPolicy = { maxAttempts: 3, transportBackoffMs: 5_000 }) {}

  isActive(runId: string): boolean { return this.activeRuns.has(runId) && !this.cancelled.has(runId); }

  async registerChild(runId: string, child: Omit<HarnessChildTask, "recoveryAttempts">): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution || !this.isActive(runId)) throw new Error("Workflow is no longer active");
    execution.run.children ??= [];
    if (!execution.run.children.some((item) => item.taskId === child.taskId && item.provider === child.provider)) execution.run.children.push({ ...child, recoveryAttempts: 0 });
    await this.update(execution.run);
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
        const reason = session.messages.filter((message) => message.role === "error" || message.role === "assistant").slice(-2).map((message) => message.text).join("\n");
        child.failureReason = classifyWorkflowFailure(reason);
        if (!isRetryableFailure(child.failureReason) || !retryDue(child.retryAt) || !this.isActive(runId)) continue;
        child.recoveryAttempts += 1; child.recoveryError = undefined; child.retryAt = nextRetryAt(child.failureReason, child.recoveryAttempts, this.recovery);
        this.log(state, "lifecycle", `Resuming child ${child.taskId} after ${child.failureReason}, attempt ${child.recoveryAttempts}/${this.recovery.maxAttempts}`);
        await this.update(execution.run);
        this.assertActive(runId);
        await resume(child, session);
        this.assertActive(runId);
      } catch (error) {
        if (error instanceof Cancelled) return;
        child.recoveryError = error instanceof Error ? error.message : String(error);
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
    const run: HarnessRun = { id: crypto.randomUUID(), harnessId, harnessVersion: harness.version, input: input.trim(), status: "queued", createdAt: new Date().toISOString(), blocks: validation.order.map((blockId) => ({ blockId, status: "queued" })) };
    run.definition = structuredClone(harness);
    await this.store.saveRun(run); this.changed(run.id);
    this.activeRuns.add(run.id); void this.execute(run, harness.blocks, harness.edges, validation.order, dispatch, defaultProvider, append ?? (async () => { throw new Error("This workflow runtime cannot append to an active block session"); }));
    return run;
  }

  async cancel(runId: string, interrupt: Interrupt): Promise<HarnessRun> {
    const persisted = (await this.store.runs()).find((item) => item.id === runId);
    const execution = this.executions.get(runId); const run = execution?.run ?? persisted;
    if (!run) throw new CoreError("FILE_NOT_FOUND", "Harness run does not exist");
    if (!["queued", "running", "waiting"].includes(run.status)) return run;
    if (this.activeRuns.has(runId)) this.cancelled.add(runId);
    const active = run.blocks.filter((block) => block.status === "running" && block.provider);
    const completedAt = new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
    for (const block of run.blocks) if (["queued", "running", "waiting"].includes(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
    run.cleanupErrors = undefined; await this.update(run);
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
    void Promise.all(available.map(async (block) => {
      const state = execution.run.blocks.find((item) => item.blockId === block.id)!;
      this.assertActive(runId);
      const session = await execution.append(block, value, { runId, blockId: block.id, workspace: state.workspace! });
      this.assertActive(runId);
      const output = session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
      state.sessionId = session.id; state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(block.id, output);
      await this.update(execution.run);
    })).catch(async (error) => { if (error instanceof Cancelled || this.cancelled.has(runId)) return; execution.run.status = "failed"; execution.run.error = error instanceof Error ? error.message : String(error); execution.run.completedAt = new Date().toISOString(); await this.update(execution.run); });
    return structuredClone(execution.run);
  }

  async resumeFailed(runId: string, callerId: string): Promise<{ resumed: string[] }> {
    const execution = this.executions.get(runId);
    if (!execution || this.cancelled.has(runId)) throw new Error("Workflow is no longer active");
    if (!execution.blocks.find((block) => block.id === callerId)?.watchdog) throw new Error("Only a watchdog can request recovery");
    const resumed: string[] = [];
    for (const state of execution.run.blocks) {
      if (state.status !== "failed" || state.blockId === callerId) continue;
      state.failureReason ??= classifyWorkflowFailure(state.error ?? "");
      if (!isRetryableFailure(state.failureReason) || !retryDue(state.retryAt) || (state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts) continue;
      state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
      state.status = "queued"; state.error = undefined; state.completedAt = undefined; state.retryAt = undefined;
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
    let outgoing = execution.edges.filter((edge) => edge.from === blockId);
    if (path !== undefined) outgoing = outgoing.filter((edge) => edge.label === path);
    if (!outgoing.length) throw new Error(path === undefined ? "This block has no downstream path" : `No downstream path named '${path}'`);
    if (caller.routing === "ai" && path === undefined) throw new Error("path is required because this block uses AI-selected routing");
    if (path !== undefined) callerState.selectedRoute = path;
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
      state.status = "running"; state.completedAt = undefined; await this.update(execution.run);
      const replies: string[] = [];
      for (const input of inputs) { this.assertActive(runId); const session = await execution.append(target, input, { runId, blockId: target.id, workspace: state.workspace }); this.assertActive(runId); replies.push(session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""); state.sessionId = session.id; }
      const output = replies.length === 1 ? replies[0]! : replies.map((value, index) => `## Appended prompt ${index + 1}\n${value}`).join("\n\n"); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(target.id, output); await this.update(execution.run);
    };
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

  private async execute(run: HarnessRun, blocks: HarnessBlock[], edges: HarnessEdge[], order: string[], dispatch: Dispatch, defaultProvider: string, append: Append): Promise<void> {
    const outputs = new Map<string, string>(); run.status = "running"; run.startedAt = new Date().toISOString(); const background = new Set<Promise<void>>(); this.executions.set(run.id, { run, blocks, edges, outputs, dispatch, append, defaultProvider, background }); await this.update(run);
    const running = new Map<string, Promise<{ blockId: string; error?: unknown }>>();
    try {
      while (run.blocks.some((block) => ["queued", "waiting", "running"].includes(block.status))) {
        if (this.cancelled.has(run.id)) throw new Cancelled();
        let changed = false;
        for (const blockId of order) {
          if (running.size >= this.concurrency) break;
          const state = run.blocks.find((item) => item.blockId === blockId)!;
          if (!["queued", "waiting"].includes(state.status)) continue;
          const readiness = blockReadiness(blockId, blocks, edges, run.blocks);
          if (readiness === "wait") { if (state.status !== "waiting") { state.status = "waiting"; this.log(state, "lifecycle", "Waiting for upstream blocks"); changed = true; } continue; }
          if (readiness === "skip") { state.status = "skipped"; state.completedAt = new Date().toISOString(); changed = true; continue; }
          const block = blocks.find((item) => item.id === blockId)!; state.status = "running"; changed = true;
          const task = this.executeBlock(run, block, blocks, edges, outputs, dispatch, defaultProvider).then(() => ({ blockId }), async (error) => {
            if (this.cancelled.has(run.id) || !blocks.some((item) => item.watchdog)) return { blockId, error };
            state.status = "failed"; state.error = error instanceof Error ? error.message : String(error); state.failureReason = classifyWorkflowFailure(error);
            state.retryAt = nextRetryAt(state.failureReason, state.recoveryAttempts ?? 0, this.recovery);
            this.log(state, "error", state.error); await this.update(run);
            return { blockId };
          });
          running.set(blockId, task);
        }
        if (changed) await this.update(run);
        if (!running.size) {
          if (background.size) { await Promise.race(background); continue; }
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
      run.status = "succeeded"; run.completedAt = new Date().toISOString(); await this.update(run);
    } catch (error) {
      const cancelled = error instanceof Cancelled || this.cancelled.has(run.id); run.status = cancelled ? "cancelled" : "failed"; run.error = cancelled ? undefined : error instanceof Error ? error.message : String(error); run.completedAt = new Date().toISOString();
      for (const block of run.blocks) if (["running", "queued", "waiting"].includes(block.status)) { block.status = cancelled ? "cancelled" : block.status === "running" ? "failed" : "cancelled"; if (block.status === "failed") { block.error = run.error; block.failureReason = classifyWorkflowFailure(error); } }
      await this.update(run);
    } finally {
      await Promise.allSettled([...running.values(), ...background]);
      if (this.cancelled.has(run.id)) {
        const completedAt = run.completedAt ?? new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
        for (const block of run.blocks) if (["running", "queued", "waiting"].includes(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
        await this.update(run);
      }
      this.cancelled.delete(run.id); this.activeRuns.delete(run.id); this.activeProviders.delete(run.id); this.executions.delete(run.id);
    }
  }

  private async executeBlock(run: HarnessRun, block: HarnessBlock, blocks: HarnessBlock[], edges: HarnessEdge[], outputs: Map<string, string>, dispatch: Dispatch, defaultProvider: string, stack?: string[]): Promise<void> {
    const state = run.blocks.find((item) => item.blockId === block.id)!; const outgoing = edges.filter((edge) => edge.from === block.id);
    const loopOutgoing = outgoing.filter((edge) => edge.loop);
    const blockInput = connectedInput(block.id, run.input, blocks, edges, outputs); const count = stack?.length ?? 1; const collected: string[] = [];
    state.startedAt = new Date().toISOString(); state.provider = block.provider ?? defaultProvider; state.plannedRuns = count; state.iterations = count > 1 ? [] : undefined; state.log = state.log ?? []; this.log(state, "lifecycle", `Started ${count > 1 ? `${count} planned iterations` : "block"}`);
    const providers = this.activeProviders.get(run.id) ?? new Set<string>(); providers.add(state.provider); this.activeProviders.set(run.id, providers); await this.update(run);
    try {
      for (let index = 0; index < count; index += 1) {
        this.assertActive(run.id);
        let prompt = renderHarnessPrompt(block.prompt, stack?.[index] ?? blockInput, outputs).replace(/\{\{\s*iteration\s*\}\}/g, String(index + 1));
        if (index === 0 && state.workspace) prompt = `Continue your interrupted work from this session. Inspect prior tool results and preserve recorded task IDs and completed merges; do not duplicate previously completed operations. Original stage instructions:\n\n${prompt}`;
        if (outgoing.length) prompt += `\n\nWorkflow runtime capability: Use workflow_run_stack to send prompts to directly connected blocks and wait for their replies. If a connected block already has a session, the prompt is appended to that same session. Use timer_set to pause yourself and resume this same session later.`;
        if (loopOutgoing.length) prompt += `\nLoop paths return to earlier workflow blocks for another cycle. Use one only when another pass is needed: ${loopOutgoing.map((edge) => edge.label ?? blocks.find((item) => item.id === edge.to)?.label ?? edge.to).join(", ")}.`;
        if (block.routing === "ai" && outgoing.length) prompt += `\nChoose a named path when calling workflow_run_stack. Available paths: ${outgoing.map((edge) => edge.label).join(", ")}.`;
        if (block.type === "task") prompt += `\n\nThis is a visible task-orchestration block. Create implementation workspaces with task_create_and_start, inspect them with task_list and task_ai_response_tail, append instructions with task_append_prompt, and merge completed work with task_merge.`;
        state.prompt = prompt;
        this.log(state, "prompt", prompt);
        const iteration: HarnessBlockIteration | undefined = state.iterations ? { index: index + 1, status: "running", startedAt: new Date().toISOString(), prompt } : undefined; if (iteration) state.iterations!.push(iteration); await this.update(run);
        try {
          const started = async (workspace: string) => { this.assertActive(run.id); state.workspace = workspace; if (iteration) iteration.workspace = workspace; await this.update(run); this.assertActive(run.id); };
          const execution = this.executions.get(run.id);
          this.assertActive(run.id);
          const settled = state.workspace && execution
            ? await execution.append(block, prompt, { runId: run.id, blockId: block.id, workspace: state.workspace })
            : await dispatch(block, prompt, { runId: run.id, blockId: block.id, iteration: index + 1, started, assertActive: () => this.assertActive(run.id) });
          this.assertActive(run.id);
          state.sessionId = settled.id; if (iteration) iteration.sessionId = settled.id;
          this.log(state, "response", settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "Provider turn completed without an assistant response");
          if (settled.status === "user_prompt") throw new CoreError("INVALID_REQUEST", `${block.label} requires user input; resume support is not implemented yet`);
          if (settled.status === "error") throw new Error([settled.messages.filter((message) => message.role === "error").at(-1)?.text ?? `${block.label} failed`, settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""].join("\n"));
          let output = settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
          collected.push(output); if (iteration) { iteration.output = output.slice(-200_000); iteration.status = "succeeded"; iteration.completedAt = new Date().toISOString(); } await this.update(run);
        } catch (error) {
          this.log(state, "error", error instanceof Error ? error.message : String(error));
          if (iteration) { iteration.status = error instanceof Cancelled ? "cancelled" : "failed"; iteration.error = error instanceof Error ? error.message : String(error); iteration.completedAt = new Date().toISOString(); } throw error;
        }
      }
      const output = count === 1 ? collected[0] ?? "" : collected.map((value, index) => `## Stack item ${index + 1}\n${value}`).join("\n\n");
      this.assertActive(run.id);
      outputs.set(block.id, output); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); state.failureReason = undefined; state.retryAt = undefined; this.log(state, "lifecycle", "Completed successfully"); await this.update(run);
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

  private deliveryIsTerminal(execution: ActiveExecution): boolean {
    return execution.blocks.filter((block) => !block.watchdog).every((block) => {
      const state = execution.run.blocks.find((item) => item.blockId === block.id);
      if (!state) return false;
      if (["succeeded", "skipped", "cancelled"].includes(state.status)) return true;
      if (state.status !== "failed") return false;
      const reason = state.failureReason ?? classifyWorkflowFailure(state.error ?? "");
      return !isRetryableFailure(reason) || (state.recoveryAttempts ?? 0) >= this.recovery.maxAttempts;
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

class Cancelled extends Error {}

export function isRecoverableWorkflowError(message: string): boolean {
  return isRetryableFailure(classifyWorkflowFailure(message));
}

export function classifyWorkflowFailure(error: unknown): HarnessFailureReason {
  if (error instanceof Cancelled) return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/usage limit|rate.?limit|quota|HTTP 429/i.test(message)) return "quota_exhausted";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|HTTP 50[234]/i.test(message)) return "transient_transport";
  if (/permission|approval required|request_permission/i.test(message)) return "permission_required";
  if (/requires user input|user_prompt|awaiting user input/i.test(message)) return "user_input_required";
  if (/cancelled|canceled|aborted/i.test(message)) return "cancelled";
  return "permanent";
}

function isRetryableFailure(reason: HarnessFailureReason): boolean { return reason === "quota_exhausted" || reason === "transient_transport"; }
function retryDue(value?: string): boolean { return value === undefined || Date.parse(value) <= Date.now(); }
function nextRetryAt(reason: HarnessFailureReason, attempts: number, policy: RecoveryPolicy): string | undefined {
  return reason === "transient_transport" ? new Date(Date.now() + policy.transportBackoffMs * 2 ** attempts).toISOString() : undefined;
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
