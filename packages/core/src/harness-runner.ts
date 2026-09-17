import crypto from "node:crypto";
import type { HarnessBlock, HarnessEdge, HarnessRun, AiSession } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { validateHarness, renderHarnessPrompt } from "./harness-graph.js";
import type { HarnessStore } from "./harnesses.js";

type Dispatch = (block: HarnessBlock, prompt: string) => Promise<AiSession>;
type Interrupt = (provider: string) => Promise<void>;

export class HarnessRunner {
  private readonly cancelled = new Set<string>();
  private readonly activeRuns = new Set<string>();
  private readonly activeProviders = new Map<string, string>();
  constructor(private readonly store: HarnessStore, private readonly changed: (runId: string) => void) {}

  async start(harnessId: string, input: string, dispatch: Dispatch, defaultProvider = "codex"): Promise<HarnessRun> {
    if (!input.trim() || input.length > 100_000) throw new CoreError("INVALID_REQUEST", "Harness input must contain 1–100,000 characters");
    const harness = await this.store.read(harnessId); const validation = validateHarness(harness);
    if (!validation.valid) throw new CoreError("INVALID_REQUEST", validation.issues.map((issue) => issue.message).join("; "));
    const run: HarnessRun = { id: crypto.randomUUID(), harnessId, harnessVersion: harness.version, input: input.trim(), status: "queued", createdAt: new Date().toISOString(), blocks: validation.order.map((blockId) => ({ blockId, status: "queued" })) };
    await this.store.saveRun(run); this.changed(run.id);
    this.activeRuns.add(run.id); void this.execute(run, harness.blocks, harness.edges, validation.order, dispatch, defaultProvider);
    return run;
  }

  async cancel(runId: string, interrupt: Interrupt): Promise<HarnessRun> {
    const run = (await this.store.runs()).find((item) => item.id === runId);
    if (!run) throw new CoreError("FILE_NOT_FOUND", "Harness run does not exist");
    if (!["queued", "running", "waiting"].includes(run.status)) return run;
    if (this.activeRuns.has(runId)) this.cancelled.add(runId);
    const completedAt = new Date().toISOString(); run.status = "cancelled"; run.completedAt = completedAt; run.error = undefined;
    for (const block of run.blocks) if (["queued", "running", "waiting"].includes(block.status)) { block.status = "cancelled"; block.completedAt = completedAt; block.error = undefined; }
    await this.update(run);
    const provider = this.activeProviders.get(runId); if (provider) await interrupt(provider).catch(() => undefined);
    return run;
  }

  private async execute(run: HarnessRun, blocks: HarnessBlock[], edges: HarnessEdge[], order: string[], dispatch: Dispatch, defaultProvider: string): Promise<void> {
    const outputs = new Map<string, string>(); run.status = "running"; run.startedAt = new Date().toISOString(); await this.update(run);
    try {
      for (const blockId of order) {
        if (this.cancelled.has(run.id)) throw new Cancelled();
        const block = blocks.find((item) => item.id === blockId)!; const state = run.blocks.find((item) => item.blockId === blockId)!;
        const blockInput = connectedInput(block.id, run.input, blocks, edges, outputs);
        const prompt = renderHarnessPrompt(block.prompt, blockInput, outputs); state.status = "running"; state.startedAt = new Date().toISOString(); state.prompt = prompt; state.provider = block.provider ?? defaultProvider; this.activeProviders.set(run.id, state.provider); await this.update(run);
        const settled = await dispatch(block, prompt); state.sessionId = settled.id;
        if (this.cancelled.has(run.id)) throw new Cancelled();
        if (settled.status === "user_prompt") throw new CoreError("INVALID_REQUEST", `${block.label} requires user input; resume support is not implemented yet`);
        if (settled.status === "error") throw new Error(settled.messages.filter((message) => message.role === "error").at(-1)?.text ?? `${block.label} failed`);
        const output = settled.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? ""; outputs.set(block.id, output); state.output = output.slice(-200_000); state.status = "succeeded"; state.completedAt = new Date().toISOString(); await this.update(run);
      }
      run.status = "succeeded"; run.completedAt = new Date().toISOString(); await this.update(run);
    } catch (error) {
      const cancelled = error instanceof Cancelled || this.cancelled.has(run.id); run.status = cancelled ? "cancelled" : "failed"; run.error = cancelled ? undefined : error instanceof Error ? error.message : String(error); run.completedAt = new Date().toISOString();
      for (const block of run.blocks) if (block.status === "running" || block.status === "queued") { block.status = cancelled ? "cancelled" : block.status === "running" ? "failed" : "cancelled"; if (block.status === "failed") block.error = run.error; }
      await this.update(run);
    } finally { this.cancelled.delete(run.id); this.activeRuns.delete(run.id); this.activeProviders.delete(run.id); }
  }

  private async update(run: HarnessRun): Promise<void> { await this.store.saveRun(run); this.changed(run.id); }
}

export function connectedInput(blockId: string, harnessInput: string, blocks: HarnessBlock[], edges: HarnessEdge[], outputs: ReadonlyMap<string, string>): string {
  const predecessors = edges.filter((edge) => edge.to === blockId).map((edge) => edge.from);
  if (!predecessors.length) return harnessInput;
  const available = predecessors.map((id) => ({ id, output: outputs.get(id) })).filter((item): item is { id: string; output: string } => item.output !== undefined);
  if (available.length === 1) return available[0]!.output;
  return available.map(({ id, output }) => `## ${blocks.find((block) => block.id === id)?.label ?? id}\n${output}`).join("\n\n");
}

class Cancelled extends Error {}
