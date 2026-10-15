import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner, connectedInput } from "./harness-runner.js";

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

it.each(["Static chat instructions", "Goal: {{input}}; Tool: {{blocks.tool.output}}"])("sends Chatbox instructions once and only includes dynamic data in later turns: %s", async (prompt) => {
  const f = await setup([block("chat", "chatbox", { prompt }), block("tool", "text", { prompt: "tool-result" })]);
  const dispatch = vi.fn(async (_block, firstPrompt, runtime) => {
    expect(firstPrompt).toBe("first-user-message");
    expect(runtime.instructions).toContain("Connected tools:");
    expect(runtime.instructions).toContain(prompt.startsWith("Static") ? prompt : "Goal: {{input}}; Tool:");
    expect(runtime.instructions).not.toContain("first-user-message");
    await runtime.started("/chat/session");
    await f.runner.flowTool(runtime.runId, "chat", "workflow_use_block", { block_id: "tool" });
    return session("First response");
  });
  const append = vi.fn(async (_block, nextPrompt) => {
    expect(nextPrompt).not.toContain("Connected tools:");
    expect(nextPrompt.split("second-user-message")).toHaveLength(2);
    expect(nextPrompt).not.toContain("Goal:");
    expect(nextPrompt).not.toContain("Static chat instructions");
    if (prompt.startsWith("Static")) expect(nextPrompt).toBe("second-user-message");
    else expect(nextPrompt).toContain("tool: tool-result");
    return session("Second response");
  });
  const run = await f.runner.start(f.definition.id, "first-user-message", dispatch, "test", append, "chat");
  f.setRunId(run.id); await f.finished();
  // Continuing after a runner restart must not re-send the Chatbox instructions.
  const resumed = new HarnessRunner(f.store, () => {});
  await resumed.continueChat(run.id, "chat", "second-user-message", dispatch, "test", append);
  await vi.waitFor(() => expect(resumed.isActive(run.id)).toBe(false));
  expect((await resumed.readRun(run.id))?.status).toBe("succeeded");
  expect(dispatch).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
});

it.each(["Static agent instructions", "Goal: {{input}}; Tool: {{blocks.tool.output}}"])("preserves AI Agent follow-up templates: %s", async (prompt) => {
  const f = await setup([block("parent", "chatbox"), block("agent", "ai", { prompt }), block("tool", "text", { prompt: "tool-result" })]);
  const append = vi.fn(async (_block, nextPrompt) => {
    expect(nextPrompt).not.toContain("Connected tools:");
    if (prompt.startsWith("Static")) expect(nextPrompt).toBe("second");
    else {
      expect(nextPrompt).toContain("Goal: second; Tool:");
      expect(nextPrompt).toContain("output unchanged");
    }
    return session("Second response");
  });
  const run = await f.runner.start(f.definition.id, "Start", async (target, _prompt, runtime) => {
    await runtime.started(`/session/${target.id}`);
    if (target.id === "parent") {
      await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "tool" });
      await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "agent", input: "first" });
      await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "agent", input: "second" });
    }
    return session("Done");
  }, "test", append, "parent");
  f.setRunId(run.id);
  expect((await f.finished())?.status).toBe("succeeded");
  expect(append).toHaveBeenCalledOnce();
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
        if (i === 0) expect(progress).toMatchObject({ messages: [] });
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

it("bounds dynamic reports, omits unchanged reports, and pages retained tool output", async () => {
  const report = "Report start\n" + "detail\n".repeat(10_000) + "Report end";
  const f = await setup([block("chat", "chatbox", { prompt: "{{input}}\nReport: {{blocks.tool.output}}" }), block("tool", "text", { prompt: "{{input}}" })]);
  const dispatch = vi.fn(async (_block, _prompt, runtime) => {
    await runtime.started("/chat/session");
    const result = await f.runner.flowTool(runtime.runId, "chat", "workflow_use_block", { block_id: "tool", input: report });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
    expect(result).toMatchObject({ truncated: true });
    const page = await f.runner.flowTool(runtime.runId, "chat", "workflow_block_output", { block_id: "tool", offset: 8000, limit: 100 });
    expect(page).toMatchObject({ output: report.slice(8000, 8100), nextOffset: 8100, totalChars: report.length });
    return session("First response");
  });
  const append = vi.fn(async (_block, prompt, runtime) => {
    if (append.mock.calls.length === 1) {
      expect(prompt).toContain("Report start");
      expect(prompt).toContain("Report end");
      expect(prompt).toContain("truncated");
      expect(prompt.length).toBeLessThan(9000);
    } else if (append.mock.calls.length === 2) {
      expect(prompt).toContain("output unchanged");
      expect(prompt).not.toContain("detail");
      await f.runner.flowTool(runtime.runId, "chat", "workflow_use_block", { block_id: "tool", input: "Changed report {{input}}" });
    } else {
      expect(prompt).toContain("Changed report {{input}}");
      expect(prompt).not.toContain("output unchanged");
    }
    return session("Next response");
  });
  const run = await f.runner.start(f.definition.id, "First", dispatch, "test", append, "chat");
  f.setRunId(run.id); await f.finished();
  for (const input of ["Second", "Third", "Fourth"]) {
    await f.runner.continueChat(run.id, "chat", input, dispatch, "test", append);
    expect((await f.finished())?.status).toBe("succeeded");
  }
  expect(append).toHaveBeenCalledTimes(3);
  expect((await f.runner.readRun(run.id))?.blocks.find((state) => state.blockId === "tool")?.output).toBe("Changed report {{input}}");
});

it("stops a long-lived chat at its persisted context budget before sending another turn", async () => {
  const f = await setup([block("chat", "chatbox")]);
  f.definition = await f.store.update({ ...f.definition, settings: { contextBudgetChars: 6000 } });
  const dispatch = vi.fn(async (_block, _prompt, runtime) => { await runtime.started("/chat/session"); return session("Ready"); });
  const append = vi.fn(async () => session("Unexpected"));
  const run = await f.runner.start(f.definition.id, "First", dispatch, "test", append, "chat");
  f.setRunId(run.id);
  const first = await f.finished();
  expect(first?.status).toBe("succeeded");
  expect(first?.blocks[0]?.deliveredContextChars).toBeGreaterThan(0);
  await f.runner.continueChat(run.id, "chat", "more context ".repeat(500), dispatch, "test", append);
  const stopped = await f.finished();
  expect(stopped?.status).toBe("failed");
  expect(stopped?.blocks[0]?.error).toContain("context budget");
  expect(append).not.toHaveBeenCalled();
});

it("suppresses direct tail repeats and overlapping polling messages", async () => {
  const f = await setup([block("parent", "ai"), block("child", "chatbox")]);
  const run = await f.runner.start(f.definition.id, "Inspect", async (target, _prompt, runtime) => {
    await runtime.started(`/session/${target.id}`);
    if (target.id === "child") return session("Worker report");
    await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", { block_id: "child", input: "Work" });
    const args = { block_id: "child", action: "tail" };
    expect(await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", args)).toMatchObject({ messages: expect.any(Array) });
    expect(await f.runner.flowTool(runtime.runId, "parent", "workflow_use_block", args)).toMatchObject({ unchanged: true });
    const poll = await f.runner.flowTool(runtime.runId, "parent", "workflow_block_messages", { block_id: "child" });
    expect(poll).toMatchObject({ messages: [] });
    return session("Done");
  }, "test", undefined, "parent");
  f.setRunId(run.id);
  expect((await f.finished())?.status).toBe("succeeded");
});

it("shares a bounded fan-in input among predecessors and preserves non-AI data", () => {
  const blocks = [block("a", "text"), block("b", "text"), block("join", "ai"), block("document", "markdown")];
  const edges = ["a", "b"].flatMap((from) => ["join", "document"].map((to) => ({ id: `${from}-${to}`, from, to })));
  const outputs = new Map([["a", "A".repeat(40_000)], ["b", "B".repeat(40_000)]]);
  const joined = connectedInput("join", "", blocks, edges, outputs);
  expect(joined.length).toBeLessThanOrEqual(20_000);
  expect(joined).toContain("## a"); expect(joined).toContain("## b");
  expect(joined).toContain("AAAA"); expect(joined).toContain("BBBB");
  expect(connectedInput("document", "", blocks, edges, outputs).length).toBeGreaterThan(80_000);
});
