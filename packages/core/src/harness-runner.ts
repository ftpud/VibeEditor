import crypto from "node:crypto";
import type { HarnessBlock, HarnessBlockIteration, HarnessEdge, HarnessRun, HarnessLogEntry, AiSession } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { validateHarness, renderHarnessPrompt } from "./harness-graph.js";
import type { HarnessStore } from "./harnesses.js";

type Dispatch = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; iteration: number; started(workspace: string): Promise<void> }) => Promise<AiSession>;
type Append = (block: HarnessBlock, prompt: string, context: { runId: string; blockId: string; workspace: string }) => Promise<AiSession>;
type Interrupt = (provider: string, context: { runId: string; blockId: string; workspace?: string }) => Promise<void>;
type ActiveExecution = { run: HarnessRun; blocks: HarnessBlock[]; edges: HarnessEdge[]; outputs: Map<string, string>; dispatch: Dispatch; append: Append; defaultProvider: string };

export class HarnessRunner {
  private readonly cancelled = new Set<string>();
  private readonly activeRuns = new Set<string>();
  private readonly activeProviders = new Map<string, Set<string>>();
  private readonly executions = new Map<string, ActiveExecution>();
  private updateQueue = Promise.resolve();
  constructor(private readonly store: HarnessStore, private readonly changed: (runId: string) => void, private readonly concurrency = 4) {}

  async start(harnessId: string, input: string, dispatch: Dispatch, defaultProvider = "codex", append?: Append): Promise<HarnessRun> {
    if (!input.trim() || input.length > 100_000) throw new CoreError("INVALID_REQUEST", "Harness input must contain 1–100,000 characters");
    const harness = await this.store.read(harnessId); const validation = validateHarness(harness);
    if (!validation.valid) throw new CoreError("INVALID_REQUEST", validation.issues.map((issue) => issue.message).join("; "));
    const run: HarnessRun = { id: crypto.randomUUID(), harnessId, harnessVersion: harness.version, input: input.trim(), status: "queued", createdAt: new Date().toISOString(), blocks: validation.order.map((blockId) => ({ blockId, status: "queued" })) };
    await this.store.saveRun(run); this.changed(run.id);
    this.activeRuns.add(run.id); void this.execute(run, harness.blocks, harness.edges, validation.order, dispatch, defaultProvider, append ?? (async () => { throw new Error("This workflow runtime cannot append to an active block session"); }));
    return run;
  }

  async cancel(runId: string, interrupt: Interrupt): Promise<HarnessRun> {
    const run = (await this.store.runs()).find((item) => item.id === runId);
    if (!run) throw new CoreError("FILE_NOT_FOUND", "Harness run does not exist");
    if (!["queued", "running", "waiting"].includes(run.status)) return run;
    if (this.activeRuns.has(runId)) this.cancelled.add(runId);
    const active = run.blocks.filter((block) => block.status === "running" && block.provider);
    const completedAt = new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
    for (const block of run.blocks) if (["queued", "running", "waiting"].includes(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
    await this.update(run);
    await Promise.all(active.map((block) => interrupt(block.provider!, { runId, blockId: block.blockId, workspace: block.workspace }).catch(() => undefined)));
    return run;
  }

  async appendInput(runId: string, input: string): Promise<HarnessRun> {
    const value = input.trim(); if (!value || value.length > 100_000) throw new CoreError("INVALID_REQUEST", "Workflow input must contain 1–100,000 characters");
    const execution = this.executions.get(runId); if (!execution) throw new CoreError("INVALID_REQUEST", "Workflow run is no longer active");
    const targets = execution.blocks.filter((block) => !execution.edges.some((edge) => edge.to === block.id));
    const available = targets.filter((block) => { const state = execution.run.blocks.find((item) => item.blockId === block.id); return state?.workspace && state.status === "running"; });
    if (!available.length) throw new CoreError("INVALID_REQUEST", "The workflow dispatcher session is not ready for another prompt");
    for (const block of available) { const state = execution.run.blocks.find((item) => item.blockId === block.id)!; state.status = "running"; state.completedAt = undefined; state.prompt = value; }
    await this.update(execution.run);
    void Promise.all(available.map(async (block) => {
      const state = execution.run.blocks.find((item) => item.blockId === block.id)!;
      const session = await execution.append(block, value, { runId, blockId: block.id, workspace: state.workspace! });
      const output = session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
      state.sessionId = session.id; state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(block.id, output);
      await this.update(execution.run);
    })).catch(async (error) => { execution.run.status = "failed"; execution.run.error = error instanceof Error ? error.message : String(error); execution.run.completedAt = new Date().toISOString(); await this.update(execution.run); });
    return structuredClone(execution.run);
  }

  async runStack(runId: string, blockId: string, inputs: string[], path?: string): Promise<{ blocks: Array<{ blockId: string; output: string }> }> {
    const execution = this.executions.get(runId); if (!execution) throw new Error("Workflow execution is no longer active");
    if (!inputs.length || !inputs.every((input) => typeof input === "string" && input.trim())) throw new Error("inputs must be a non-empty array of strings");
    const caller = execution.blocks.find((block) => block.id === blockId); const callerState = execution.run.blocks.find((block) => block.blockId === blockId);
    if (!caller || callerState?.status !== "running") throw new Error("Only a currently running workflow block can launch a stack");
    let outgoing = execution.edges.filter((edge) => edge.from === blockId);
    if (path !== undefined) outgoing = outgoing.filter((edge) => edge.label === path);
    if (!outgoing.length) throw new Error(path === undefined ? "This block has no downstream path" : `No downstream path named '${path}'`);
    if (caller.routing === "ai" && path === undefined) throw new Error("path is required because this block uses AI-selected routing");
    if (path !== undefined) callerState.selectedRoute = path;
    const targets = outgoing.map((edge) => execution.blocks.find((block) => block.id === edge.to)!).filter(Boolean);
    const fresh: HarnessBlock[] = [];
    for (const target of targets) {
      const state = execution.run.blocks.find((item) => item.blockId === target.id)!;
      if (["queued", "waiting"].includes(state.status) && !state.workspace) { state.status = "running"; fresh.push(target); continue; }
      if (!state.workspace || !["running", "succeeded"].includes(state.status)) throw new Error(`Downstream block '${target.label}' cannot accept another prompt`);
      const replies: string[] = [];
      for (const input of inputs) { const session = await execution.append(target, input, { runId, blockId: target.id, workspace: state.workspace }); replies.push(session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""); state.sessionId = session.id; }
      const output = replies.length === 1 ? replies[0]! : replies.map((value, index) => `## Appended prompt ${index + 1}\n${value}`).join("\n\n"); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); execution.outputs.set(target.id, output);
    }
    await this.update(execution.run);
    await Promise.all(fresh.map(async (target) => {
      await this.executeBlock(execution.run, target, execution.blocks, execution.edges, execution.outputs, execution.dispatch, execution.defaultProvider, inputs);
      await this.executeRevivedDescendants(execution, target.id);
    }));
    return { blocks: targets.map((target) => ({ blockId: target.id, output: execution.outputs.get(target.id) ?? "" })) };
  }

  private async executeRevivedDescendants(execution: ActiveExecution, sourceId: string): Promise<void> {
    const targets = execution.edges.filter((edge) => edge.from === sourceId).map((edge) => execution.blocks.find((block) => block.id === edge.to)).filter((block): block is HarnessBlock => Boolean(block));
    await Promise.all(targets.map(async (target) => {
      const state = execution.run.blocks.find((item) => item.blockId === target.id)!;
      if (state.status !== "queued" && state.status !== "waiting") return;
      if (blockReadiness(target.id, execution.blocks, execution.edges, execution.run.blocks) !== "ready") return;
      state.status = "running"; await this.update(execution.run);
      await this.executeBlock(execution.run, target, execution.blocks, execution.edges, execution.outputs, execution.dispatch, execution.defaultProvider);
      await this.executeRevivedDescendants(execution, target.id);
    }));
  }

  private async execute(run: HarnessRun, blocks: HarnessBlock[], edges: HarnessEdge[], order: string[], dispatch: Dispatch, defaultProvider: string, append: Append): Promise<void> {
    const outputs = new Map<string, string>(); run.status = "running"; run.startedAt = new Date().toISOString(); this.executions.set(run.id, { run, blocks, edges, outputs, dispatch, append, defaultProvider }); await this.update(run);
    const running = new Map<string, Promise<string>>();
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
          const task = this.executeBlock(run, block, blocks, edges, outputs, dispatch, defaultProvider).then(() => blockId);
          running.set(blockId, task);
        }
        if (changed) await this.update(run);
        if (!running.size) {
          if (run.blocks.some((block) => ["queued", "waiting"].includes(block.status))) throw new Error("Harness could not resolve its remaining paths");
          break;
        }
        const completedId = await Promise.race(running.values()); running.delete(completedId);
      }
      run.status = "succeeded"; run.completedAt = new Date().toISOString(); await this.update(run);
    } catch (error) {
      const cancelled = error instanceof Cancelled || this.cancelled.has(run.id); run.status = cancelled ? "cancelled" : "failed"; run.error = cancelled ? undefined : error instanceof Error ? error.message : String(error); run.completedAt = new Date().toISOString();
      for (const block of run.blocks) if (["running", "queued", "waiting"].includes(block.status)) { block.status = cancelled ? "cancelled" : block.status === "running" ? "failed" : "cancelled"; if (block.status === "failed") block.error = run.error; }
      await this.update(run);
    } finally { this.cancelled.delete(run.id); this.activeRuns.delete(run.id); this.activeProviders.delete(run.id); this.executions.delete(run.id); }
  }

  private async executeBlock(run: HarnessRun, block: HarnessBlock, blocks: HarnessBlock[], edges: HarnessEdge[], outputs: Map<string, string>, dispatch: Dispatch, defaultProvider: string, stack?: string[]): Promise<void> {
    const state = run.blocks.find((item) => item.blockId === block.id)!; const outgoing = edges.filter((edge) => edge.from === block.id);
    const blockInput = connectedInput(block.id, run.input, blocks, edges, outputs); const count = stack?.length ?? 1; const collected: string[] = [];
    state.startedAt = new Date().toISOString(); state.provider = block.provider ?? defaultProvider; state.plannedRuns = count; state.iterations = count > 1 ? [] : undefined; state.log = state.log ?? []; this.log(state, "lifecycle", `Started ${count > 1 ? `${count} planned iterations` : "block"}`);
    const providers = this.activeProviders.get(run.id) ?? new Set<string>(); providers.add(state.provider); this.activeProviders.set(run.id, providers); await this.update(run);
    try {
      for (let index = 0; index < count; index += 1) {
        if (this.cancelled.has(run.id)) throw new Cancelled();
        let prompt = renderHarnessPrompt(block.prompt, stack?.[index] ?? blockInput, outputs).replace(/\{\{\s*iteration\s*\}\}/g, String(index + 1));
        if (outgoing.length) prompt += `\n\nWorkflow runtime capability: Use workflow_run_stack to send prompts to directly connected blocks and wait for their replies. If a connected block already has a session, the prompt is appended to that same session. Use timer_set to pause yourself and resume this same session later.`;
        if (block.routing === "ai" && outgoing.length) prompt += `\nChoose a named path when calling workflow_run_stack. Available paths: ${outgoing.map((edge) => edge.label).join(", ")}.`;
        if (block.type === "task") prompt += `\n\nThis is a visible task-orchestration block. Create implementation workspaces with task_create_and_start, inspect them with task_list and task_ai_response_tail, append instructions with task_append_prompt, and merge completed work with task_merge.`;
        state.prompt = prompt;
        this.log(state, "prompt", prompt);
        const iteration: HarnessBlockIteration | undefined = state.iterations ? { index: index + 1, status: "running", startedAt: new Date().toISOString(), prompt } : undefined; if (iteration) state.iterations!.push(iteration); await this.update(run);
        try {
          const started = async (workspace: string) => { state.workspace = workspace; if (iteration) iteration.workspace = workspace; await this.update(run); };
          const execution = this.executions.get(run.id);
          const settled = index > 0 && state.workspace && execution
            ? await execution.append(block, prompt, { runId: run.id, blockId: block.id, workspace: state.workspace })
            : await dispatch(block, prompt, { runId: run.id, blockId: block.id, iteration: index + 1, started });
          state.sessionId = settled.id; if (iteration) iteration.sessionId = settled.id;
          this.log(state, "response", settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "Provider turn completed without an assistant response");
          if (this.cancelled.has(run.id)) throw new Cancelled();
          if (settled.status === "user_prompt") throw new CoreError("INVALID_REQUEST", `${block.label} requires user input; resume support is not implemented yet`);
          if (settled.status === "error") throw new Error(settled.messages.filter((message) => message.role === "error").at(-1)?.text ?? `${block.label} failed`);
          let output = settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
          collected.push(output); if (iteration) { iteration.output = output.slice(-200_000); iteration.status = "succeeded"; iteration.completedAt = new Date().toISOString(); } await this.update(run);
        } catch (error) {
          this.log(state, "error", error instanceof Error ? error.message : String(error));
          if (iteration) { iteration.status = error instanceof Cancelled ? "cancelled" : "failed"; iteration.error = error instanceof Error ? error.message : String(error); iteration.completedAt = new Date().toISOString(); } throw error;
        }
      }
      const output = count === 1 ? collected[0] ?? "" : collected.map((value, index) => `## Stack item ${index + 1}\n${value}`).join("\n\n");
      outputs.set(block.id, output); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); this.log(state, "lifecycle", "Completed successfully"); await this.update(run);
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
}

function blockReadiness(blockId: string, blocks: HarnessBlock[], edges: HarnessEdge[], states: HarnessRun["blocks"]): "ready" | "wait" | "skip" {
  const incoming = edges.filter((edge) => edge.to === blockId); if (!incoming.length) return "ready";
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
  const predecessors = edges.filter((edge) => edge.to === blockId).map((edge) => edge.from);
  if (!predecessors.length) return harnessInput;
  const available = predecessors.map((id) => ({ id, output: outputs.get(id) })).filter((item): item is { id: string; output: string } => item.output !== undefined);
  if (available.length === 1) return available[0]!.output;
  return available.map(({ id, output }) => `## ${blocks.find((block) => block.id === id)?.label ?? id}\n${output}`).join("\n\n");
}

class Cancelled extends Error {}
