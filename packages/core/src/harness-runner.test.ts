import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { connectedInput, HarnessRunner } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";

describe("HarnessRunner", () => {
  it("runs blocks in dependency order and passes connected output as input", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-runner-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Flow");
    await store.update({ ...definition, blocks: [{ id: "one", type: "prompt", label: "One", prompt: "Plan {{input}}", position: { x: 0, y: 0 } }, { id: "two", type: "prompt", label: "Two", prompt: "Build {{input}}", position: { x: 1, y: 1 } }], edges: [{ id: "edge", from: "one", to: "two" }] });
    const dispatch = vi.fn(async (_block, prompt: string) => ({ id: prompt, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: prompt, role: "assistant" as const, text: prompt === "Plan feature" ? "the plan" : "complete", timestamp: "now" }] }));
    const runner = new HarnessRunner(store, () => undefined); const started = await runner.start(definition.id, "feature", dispatch, "test");
    for (let tries = 0; tries < 30; tries += 1) { const current = (await store.runs())[0]; if (current?.status === "succeeded") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const completed = (await store.runs())[0]!;
    expect(completed.status).toBe("succeeded"); expect(dispatch.mock.calls.map((call) => call[1])).toEqual(["Plan feature", "Build the plan"]); expect(completed.id).toBe(started.id);
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
});
