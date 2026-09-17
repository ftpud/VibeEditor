import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { HarnessRunner } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";

describe("HarnessRunner", () => {
  it("runs blocks in dependency order and passes named output", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-runner-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Flow");
    await store.update({ ...definition, blocks: [{ id: "one", type: "prompt", label: "One", prompt: "Plan {{input}}", position: { x: 0, y: 0 } }, { id: "two", type: "prompt", label: "Two", prompt: "Build {{blocks.one.output}}", position: { x: 1, y: 1 } }], edges: [{ id: "edge", from: "one", to: "two" }] });
    const dispatch = vi.fn(async (_block, prompt: string) => ({ id: prompt, model: "test", reasoning: "low", status: "done" as const, messages: [{ id: prompt, role: "assistant" as const, text: prompt === "Plan feature" ? "the plan" : "complete", timestamp: "now" }] }));
    const runner = new HarnessRunner(store, () => undefined); const started = await runner.start(definition.id, "feature", dispatch, "test");
    for (let tries = 0; tries < 30; tries += 1) { const current = (await store.runs())[0]; if (current?.status === "succeeded") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const completed = (await store.runs())[0]!;
    expect(completed.status).toBe("succeeded"); expect(dispatch.mock.calls.map((call) => call[1])).toEqual(["Plan feature", "Build the plan"]); expect(completed.id).toBe(started.id);
  });
});
