import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner } from "./harness-runner.js";

const session = (text: string): AiSession => ({ id: "session", status: "idle", messages: [{ id: "reply", role: "assistant", text, timestamp: "now" }] } as AiSession);
const block = (id: string, type: HarnessBlock["type"], extra: Partial<HarnessBlock> = {}): HarnessBlock => ({ id, type, label: id, prompt: "{{input}}", position: { x: 0, y: 0 }, ...extra });
async function setup(blocks: HarnessBlock[]) {
  const store = new HarnessStore("/workspace", await mkdtemp(path.join(os.tmpdir(), "workflow-context-")));
  const created = await store.create("Context");
  const definition = await store.update({ ...created, blocks, edges: blocks.slice(1).map((child) => ({ id: child.id, from: blocks[0]!.id, to: child.id, type: "use" as const })) });
  const runner = new HarnessRunner(store, () => {});
  const finished = async () => { await vi.waitFor(() => expect(runner.isActive(runId)).toBe(false)); return runner.readRun(runId); };
  let runId = "";
  return { store, definition, runner, finished, setRunId: (id: string) => { runId = id; } };
}

it.each(["Static chat instructions", "Goal: {{input}}; Tool: {{blocks.tool.output}}"])("keeps session instructions once and preserves dynamic templates: %s", async (prompt) => {
  const f = await setup([block("chat", "chatbox", { prompt }), block("tool", "text", { prompt: "tool-result" })]);
  const dispatch = vi.fn(async (_block, firstPrompt, runtime) => {
    expect(firstPrompt).toContain("Connected tools:");
    expect(firstPrompt.split("first-user-message")).toHaveLength(2);
    await runtime.started("/chat/session");
    await f.runner.flowTool(runtime.runId, "chat", "workflow_use_block", { block_id: "tool" });
    return session("First response");
  });
  const append = vi.fn(async (_block, nextPrompt) => {
    expect(nextPrompt).not.toContain("Connected tools:");
    expect(nextPrompt.split("second-user-message")).toHaveLength(2);
    if (prompt.startsWith("Static")) expect(nextPrompt).toBe("second-user-message");
    else expect(nextPrompt).toContain("Tool: tool-result");
    return session("Second response");
  });
  const run = await f.runner.start(f.definition.id, "first-user-message", dispatch, "test", append, "chat");
  f.setRunId(run.id); await f.finished();
  await f.runner.continueChat(run.id, "chat", "second-user-message", dispatch, "test", append);
  expect((await f.finished())?.status).toBe("succeeded");
  expect(dispatch).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
});

it("returns app logs once and keeps full block output outside the caller context", async () => {
  const log = "log-line\n".repeat(2000);
  const f = await setup([block("chat", "chatbox"), block("app", "run_app", { prompt: "", app: { name: "app", actions: ["tail"] } })]);
  const run = await f.runner.start(f.definition.id, "Inspect", async (target, _prompt, runtime) => {
    if (target.type === "run_app") return session(JSON.stringify({ name: "app", status: "running", output: log }));
    await runtime.started("/chat/session");
    const result = await f.runner.flowTool(runtime.runId, "chat", "workflow_use_block", { block_id: "app", action: "tail" }) as { app: { output: string }; output?: string };
    expect(result.app.output).toBe(log);
    expect(result).not.toHaveProperty("output");
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify({ output: log }).length + 200);
    return session("Checked");
  }, "test", undefined, "chat");
  f.setRunId(run.id);
  expect((await f.finished())?.blocks.find((state) => state.blockId === "app")?.output).toContain("log-line");
});

it("previews tool instructions without expanding their templates into the caller prompt", async () => {
  const instructions = "{{input}}\n" + "Detailed tool instructions. ".repeat(100);
  const f = await setup([block("parent", "ai"), block("tool", "text", { prompt: instructions })]);
  const run = await f.runner.start(f.definition.id, "first-user-message", async (_target, prompt, runtime) => {
    expect(prompt.split("first-user-message")).toHaveLength(2);
    expect(prompt).toContain("{{input}}");
    expect(prompt).toContain("preview; use the block");
    const result = await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "tool", input: "explicit-tool-input" });
    expect(result).toMatchObject({ output: instructions.replace("{{input}}", "explicit-tool-input") });
    return session("Done");
  }, "test", undefined, "parent");
  f.setRunId(run.id);
  expect((await f.finished())?.status).toBe("succeeded");
});

it("polls bounded messages without duplicating outputs or growing the operation journal", async () => {
  const f = await setup([block("parent", "ai"), block("child", "chatbox")]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const run = await f.runner.start(f.definition.id, "Inspect", async (target, _prompt, runtime) => {
    await runtime.started(`/session/${target.id}`);
    if (target.id === "child") {
      await runtime.activity({ ...session("x".repeat(20_000)), status: "in_progress" });
      await waiting;
      return session("Finished");
    }
    try {
      await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "child", input: "Work", timeout_seconds: 0.05 });
      const before = (await f.runner.readRun(runtime.runId))!.operations!.length;
      for (let i = 0; i < 3; i++) {
        const progress = await f.runner.flowTool(runtime.runId, "parent", "workflow_block_messages", { block_id: "child", count: 1 });
        expect(progress).not.toHaveProperty("output");
        if (i === 0) expect(progress).toMatchObject({ messages: [{ text: "x".repeat(8000), truncated: true }] });
        else expect(progress).toMatchObject({ unchanged: true });
      }
      expect(await f.runner.flowTool(runtime.runId, "parent", "workflow_block_messages", { block_id: "child", count: 1, include_unchanged: true })).toMatchObject({ messages: [{ text: "x".repeat(8000) }] });
      expect((await f.runner.readRun(runtime.runId))!.operations).toHaveLength(before);
    } finally { release(); }
    return session("Done");
  }, "test", undefined, "parent");
  f.setRunId(run.id);
  expect((await f.finished())?.status).toBe("succeeded");
});
