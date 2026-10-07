import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock, HarnessEdge } from "@remote-ide/protocol";
import { HarnessRunner } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";
import { WorkflowAppService } from "./workflow-app.js";
import { executeFlowScript } from "./workflow-script.js";
import { validateHarness } from "./harness-graph.js";

const block = (id: string, type: HarnessBlock["type"], extra: Partial<HarnessBlock> = {}): HarnessBlock => ({ id, type, label: id, prompt: "{{input}}", position: { x: 0, y: 0 }, ...extra });
const edge = (from: string, to: string, type: HarnessEdge["type"] = "follow", label?: string): HarnessEdge => ({ id: `${from}-${to}-${type}`, from, to, type, label });
const session = (output: string): AiSession => ({ id: "session", status: "idle", messages: [{ id: "message", role: "assistant", text: output, timestamp: "now" }] } as AiSession);
async function setup(blocks: HarnessBlock[], edges: HarnessEdge[], concurrency = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-types-"));
  const store = new HarnessStore("/workspace", directory);
  const created = await store.create("Flow");
  const definition = await store.update({ ...created, blocks, edges });
  const runner = new HarnessRunner(store, () => {}, concurrency);
  const finished = async () => { await vi.waitFor(async () => expect((await store.runs())[0]?.status).toMatch(/^(succeeded|failed|cancelled)$/)); return (await store.runs())[0]!; };
  return { store, definition, runner, finished };
}

describe("typed workflows", () => {
  it("keeps Chatbox conversations and sessions across turns and exposes every connected block", async () => {
    const { runner, definition, store, finished } = await setup([
      block("chat", "chatbox", { prompt: "" }), block("tool", "text", { prompt: "Tool: {{input}}" }), block("unused", "text", { prompt: "Never called" }),
    ], [edge("chat", "tool"), edge("chat", "unused", "use")]);
    let activeRunner = runner;
    const useTool = async (runId: string) => {
      expect(activeRunner.isFlowBlock(runId, "chat")).toBe(true);
      await expect(activeRunner.flowTool(runId, "chat", "workflow_use_block", { block_id: "unconnected", input: "unsafe" })).rejects.toThrow("connected block");
      return activeRunner.flowTool(runId, "chat", "workflow_use_block", { block_id: "tool", input: "requested" });
    };
    const dispatch = vi.fn(async (_block: HarnessBlock, _prompt: string, runtime: Parameters<Parameters<HarnessRunner["start"]>[2]>[2]) => {
      await runtime.started("/chat/session");
      expect(await useTool(runtime.runId)).toMatchObject({ output: "Tool: requested" });
      return session("First reply");
    });
    const append = vi.fn(async (_block: HarnessBlock, _prompt: string, runtime: Parameters<NonNullable<Parameters<HarnessRunner["start"]>[4]>>[2]) => {
      expect(runtime.workspace).toBe("/chat/session");
      expect(await useTool(runtime.runId)).toMatchObject({ output: "Tool: requested" });
      await runtime.activity?.(session("Streaming reply"));
      expect((await store.runs())[0]?.blocks.find((block) => block.blockId === "chat")?.chatMessages?.at(-1)?.text).toBe("Streaming reply");
      return session("Second reply");
    });
    const run = await runner.start(definition.id, "Hello", dispatch, "provider", append, "chat");
    expect((await finished()).blocks.find((block) => block.blockId === "unused")?.status).toBe("skipped");
    // A new runner proves that the conversation can resume from persisted state.
    activeRunner = new HarnessRunner(store, () => {}, 1);
    await activeRunner.continueChat(run.id, "chat", "Follow up", dispatch, "different-default", append);
    const final = await finished();
    expect(final.status).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
    const chat = final.blocks.find((block) => block.blockId === "chat")!;
    expect(chat.provider).toBe("provider");
    expect(chat.chatMessages?.map((message) => [message.role, message.text])).toEqual([["user", "Hello"], ["assistant", "First reply"], ["user", "Follow up"], ["assistant", "Second reply"]]);
    expect(final.blocks.find((block) => block.blockId === "tool")?.log?.filter((entry) => entry.kind === "response")).toHaveLength(2);
  });

  it("rejects overlapping Chatbox turns and permits a stopped conversation to resume", async () => {
    const { runner, definition, store, finished } = await setup([block("chat", "chatbox", { prompt: "" })], []);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (_block: HarnessBlock, _prompt: string, runtime: Parameters<Parameters<HarnessRunner["start"]>[2]>[2]) => { await runtime.started("/chat/session"); await pending; runtime.assertActive(); return session("reply"); });
    const append = vi.fn(async () => session("Resumed"));
    const run = await runner.start(definition.id, "Hello", dispatch, "provider", append, "chat");
    await vi.waitFor(async () => expect((await store.runs())[0]?.blocks[0]?.workspace).toBe("/chat/session"));
    await expect(runner.continueChat(run.id, "chat", "Too soon", dispatch, "provider", append)).rejects.toThrow("current workflow turn");
    await runner.cancel(run.id, async () => {}); release();
    await finished(); await vi.waitFor(() => expect(runner.isActive(run.id)).toBe(false));
    await vi.waitFor(() => runner.continueChat(run.id, "chat", "Try again", dispatch, "provider", append));
    expect((await finished()).blocks[0]?.chatMessages?.at(-1)?.text).toBe("Resumed");
  });

  it("runs app actions as connected tools without waiting for app exit", async () => {
    const apps = new WorkflowAppService();
    const { runner, definition, store, finished } = await setup([
      block("start", "start_input"),
      block("launch", "run_app", { prompt: "", command: "exec sleep 300", app: { action: "start", name: "server" } }),
      block("status", "run_app", { prompt: "", app: { action: "status", name: "server" } }),
      block("stop", "run_app", { prompt: "", app: { action: "kill", name: "server" } }),
    ], [edge("start", "launch"), edge("launch", "status"), edge("status", "stop")]);
    try {
      expect(validateHarness(definition).valid).toBe(true);
      expect((await store.read(definition.id)).blocks[1]?.app).toEqual({ action: "start", name: "server" });
      await runner.start(definition.id, "input", (block, input, runtime) => apps.execute(block, input, os.tmpdir(), runtime.assertActive), "missing-provider");
      const run = await finished();
      expect(run.status).toBe("succeeded");
      expect(JSON.parse(run.blocks.find((block) => block.blockId === "status")!.output!)).toMatchObject({ status: "running" });
      expect(JSON.parse(run.blocks.find((block) => block.blockId === "stop")!.output!)).toMatchObject({ status: "exited" });
    } finally { apps.closeAll(); }
  });

  it("passes each output to followers and only starts the selected entry", async () => {
    const { runner, definition, finished } = await setup([block("button", "start_button", { prompt: "Configured prompt" }), block("textStart", "start_input"), block("text", "text", { prompt: "Text: {{input}}" }), block("timer", "timer", { seconds: 0 }), block("agent", "ai")], [edge("button", "text"), edge("text", "timer"), edge("timer", "agent")]);
    const dispatch = vi.fn(async (_block, prompt) => { expect(prompt).toContain("Text: Configured prompt"); return session("result"); });
    await runner.start(definition.id, "ignored", dispatch, "provider", undefined, "button");
    const run = await finished();
    expect(run.status).toBe("succeeded"); expect(dispatch).toHaveBeenCalledOnce();
    expect(run.blocks.find((state) => state.blockId === "textStart")?.status).toBe("skipped");
    expect(run.blocks.find((state) => state.blockId === "timer")?.output).toBe("Text: Configured prompt");
  });

  it("lets an AI use text and another AI repeatedly with a single context even at concurrency one", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("instructions", "text", { prompt: "Tool: {{input}}" }), block("worker", "ai"), block("after", "text")], [edge("start", "agent"), edge("agent", "instructions", "use"), edge("agent", "worker", "use"), edge("worker", "after")]);
    const append = vi.fn(async (_block: HarnessBlock, prompt: string, _runtime: { workspace: string }) => session(`appended:${prompt}`));
    const dispatch = vi.fn(async (target, _prompt, runtime) => {
      await runtime.started(`/sessions/${target.id}`);
      if (target.id === "worker") return session("worker first");
      expect(await runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "instructions", input: "hello" })).toMatchObject({ output: "Tool: hello" });
      expect(await runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "worker", input: "first" })).toMatchObject({ output: "worker first" });
      expect(await runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "worker", input: "second" })).toMatchObject({ output: expect.stringContaining("appended:") });
      await expect(runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "after", input: "bad" })).rejects.toThrow("connected");
      return session("caller finished");
    });
    await runner.start(definition.id, "input", dispatch, "provider", append, "start");
    const run = await finished(); expect(run.status).toBe("succeeded");
    expect(dispatch.mock.calls.filter(([target]) => target.id === "worker")).toHaveLength(1); expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[2]?.workspace).toBe("/sessions/worker");
    expect(run.blocks.find((state) => state.blockId === "after")?.output).toContain("second");
  });

  it("runs the chosen path and follow with the final AI output while skipping other paths", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("yes", "text"), block("no", "text"), block("always", "text")], [edge("start", "agent"), edge("agent", "yes", "path", "yes"), edge("agent", "no", "path", "no"), edge("agent", "always")]);
    await runner.start(definition.id, "choose", async (target, _prompt, runtime) => {
      await expect(runner.flowTool(runtime.runId, target.id, "workflow_choose_path", { path: "missing" })).rejects.toThrow("connected path");
      await runner.flowTool(runtime.runId, target.id, "workflow_choose_path", { path: "yes" }); return session("final output");
    }, "provider", undefined, "start");
    const run = await finished(); expect(run.status).toBe("succeeded");
    expect(run.blocks.find((state) => state.blockId === "yes")?.output).toBe("final output");
    expect(run.blocks.find((state) => state.blockId === "always")?.output).toBe("final output");
    expect(run.blocks.find((state) => state.blockId === "no")?.status).toBe("skipped");
    expect(run.connectionTraces?.map((trace) => trace.edgeId)).toEqual(["start-agent-follow", "agent-yes-path", "agent-always-follow"]);
  });

  it("waits for a user answer and sends that answer to the next block", async () => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("question", "user_prompt", { prompt: "What next for {{input}}?" }), block("after", "text")], [edge("start", "question"), edge("question", "after")]);
    const run = await runner.start(definition.id, "project", vi.fn(), "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_user_input"));
    const paused = (await store.runs())[0]!.blocks.find((state) => state.blockId === "question")!;
    expect(paused.question).toBe("What next for project?");
    await runner.answerQuestion(run.id, "question", paused.sessionId!, paused.pauseId!, "build", vi.fn());
    const result = await finished(); expect(result.status).toBe("succeeded"); expect(result.blocks.find((state) => state.blockId === "after")?.output).toBe("build");
  });

  it.each(["yes", "no"])("validates a Yes/No answer and passes %s to followers", async (answer) => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("question", "yes_no_prompt"), block("after", "text")], [edge("start", "question"), edge("question", "after")]);
    const run = await runner.start(definition.id, "Push?", vi.fn(), "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_user_input"));
    const paused = (await store.runs())[0]!.blocks.find((state) => state.blockId === "question")!;
    await expect(runner.answerQuestion(run.id, "question", paused.sessionId!, paused.pauseId!, "maybe", vi.fn())).rejects.toThrow("Choose Yes or No");
    await runner.answerQuestion(run.id, "question", paused.sessionId!, paused.pauseId!, answer, vi.fn());
    expect((await finished()).blocks.find((state) => state.blockId === "after")?.output).toBe(answer);
    expect((await store.read(definition.id)).blocks[1]?.type).toBe("yes_no_prompt");
  });

  it("opens a Markdown document with the preceding output and passes it to followers", async () => {
    const { definition, store } = await setup([block("start", "start_input"), block("report", "markdown", { label: "Report", prompt: "" }), block("after", "text")], [edge("start", "report"), edge("report", "after")]);
    const openDocument = vi.fn();
    const runner = new HarnessRunner(store, () => {}, 1, undefined, openDocument);
    const run = await runner.start(definition.id, "# Report\n\nCommitted changes.", vi.fn(), "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("succeeded"));
    expect(openDocument).toHaveBeenCalledOnce();
    expect(openDocument).toHaveBeenCalledWith({ runId: run.id, blockId: "report", title: "Report.md", content: "# Report\n\nCommitted changes." });
    expect((await store.runs())[0]?.blocks.find((state) => state.blockId === "after")?.output).toBe("# Report\n\nCommitted changes.");
    expect((await store.read(definition.id)).blocks[1]?.type).toBe("markdown");
  });

  it("cancels a timer without launching its follower", async () => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("timer", "timer", { seconds: 60 }), block("after", "ai")], [edge("start", "timer"), edge("timer", "after")]);
    const dispatch = vi.fn(); const run = await runner.start(definition.id, "wait", dispatch, "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("waiting_timer"));
    await runner.cancel(run.id, vi.fn()); await finished(); expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows reciprocal use and follow connections", async () => {
    const { definition } = await setup([block("a", "ai"), block("b", "ai")], [edge("a", "b", "use"), edge("b", "a", "use")]);
    expect(validateHarness(definition).valid).toBe(true);
    expect(validateHarness({ ...definition, edges: [edge("a", "b"), edge("b", "a")] })).toMatchObject({ valid: true, order: ["a", "b"] });
  });
  it("returns through a chosen path, reuses the AI session, and exits the cycle", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("revise", "text"), block("done", "text")], [edge("start", "agent"), edge("agent", "revise", "path", "again"), edge("revise", "agent"), edge("agent", "done", "path", "done")]);
    const dispatch = vi.fn(async (_target, _prompt, runtime) => {
      await runtime.started("/sessions/agent");
      await runner.flowTool(runtime.runId, "agent", "workflow_choose_path", { path: "again" });
      return session("first pass");
    });
    const append = vi.fn(async (_target: HarnessBlock, prompt: string, runtime: { runId: string; workspace: string }) => {
      expect(runtime.workspace).toBe("/sessions/agent"); expect(prompt).toContain("first pass");
      await runner.flowTool(runtime.runId, "agent", "workflow_choose_path", { path: "done" });
      return session("finished");
    });
    await runner.start(definition.id, "input", dispatch, "provider", append);
    const run = await finished(); expect(run.status).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
    expect(run.blocks.find((state) => state.blockId === "done")?.output).toBe("finished");
  });

  it("starts a cycle without a root and stops at the configured loop limit", async () => {
    const { runner, store, definition, finished } = await setup([block("a", "text"), block("b", "text")], [edge("a", "b"), edge("b", "a")]);
    await store.update({ ...definition, settings: { maxLoopCount: 2 } });
    await runner.start(definition.id, "input", vi.fn());
    const run = await finished(); expect(run.status).toBe("failed");
    expect(run.error).toContain("limit of 2 iterations");
    expect(run.blocks.map((state) => state.blockId)).toEqual(["a", "b"]);
  });

  it("rejects recursive tool calls to an AI block that is still active", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("a", "ai"), block("b", "ai")], [edge("start", "a"), edge("a", "b", "use"), edge("b", "a", "use")]);
    await runner.start(definition.id, "input", async (target, _prompt, runtime) => {
      if (target.id === "a") await runner.flowTool(runtime.runId, "a", "workflow_use_block", { block_id: "b", input: "work" });
      else await expect(runner.flowTool(runtime.runId, "b", "workflow_use_block", { block_id: "a", input: "recurse" })).rejects.toThrow("already active");
      return session("done");
    });
    expect((await finished()).status).toBe("succeeded");
  });

  it("executes a script through MCP and passes stdout to its follower", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("script", "script", { command: 'printf "result:%s" "$VIBE_WORKFLOW_INPUT"' }), block("after", "text")], [edge("start", "agent"), edge("agent", "script", "use"), edge("script", "after")]);
    await runner.start(definition.id, "input", async (target, input, runtime) => {
      if (target.type === "script") return executeFlowScript(target, input, os.tmpdir(), runtime.assertActive);
      expect(await runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "script", input: "hello" })).toMatchObject({ output: "result:hello" });
      return session("done");
    }, "provider", undefined, "start");
    const run = await finished(); expect(run.status).toBe("succeeded"); expect(run.blocks.find((state) => state.blockId === "after")?.output).toBe("result:hello");
  });

  it("fails when the AI finishes without choosing a path", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("after", "text")], [edge("start", "agent"), edge("agent", "after", "path", "next")]);
    await runner.start(definition.id, "input", async () => session("done"), "provider", undefined, "start");
    const run = await finished(); expect(run.status).toBe("failed"); expect(run.error).toContain("without choosing a path");
    expect(run.blocks.find((state) => state.blockId === "start")?.status).toBe("succeeded");
    expect(run.blocks.find((state) => state.blockId === "after")?.output).toBeUndefined();
  });

  it("rejects a stale user answer after cancellation", async () => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("question", "user_prompt")], [edge("start", "question")]);
    const run = await runner.start(definition.id, "question", vi.fn(), "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.status).toBe("awaiting_user_input"));
    const state = (await store.runs())[0]!.blocks.find((state) => state.blockId === "question")!;
    await runner.cancel(run.id, vi.fn());
    await expect(runner.answerQuestion(run.id, "question", state.sessionId!, state.pauseId!, "too late", vi.fn())).rejects.toThrow("active");
    expect((await finished()).status).toBe("cancelled");
  });

  it("shows each check-in while waiting and restores connected tools before timer delivery", async () => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("snapshot", "text", { prompt: "workspace status" })], [edge("start", "agent"), edge("agent", "snapshot", "use")]);
    await runner.start(definition.id, "check in", async (target, _prompt, runtime) => {
      await runtime.started("/sessions/agent");
      await runtime.activity(session("first check-in report"), new Date(Date.now() + 300_000).toISOString());
      expect((await store.runs())[0]?.blocks.find((state) => state.blockId === "agent")).toMatchObject({ status: "waiting_timer", output: "first check-in report" });
      await runner.runTimerOperation(runtime.runId, target.id, "cycle-1-fire", {}, async () => {
        expect(await runner.flowTool(runtime.runId, target.id, "workflow_use_block", { block_id: "snapshot", input: "inspect" })).toMatchObject({ output: "workspace status" });
      });
      return session("second check-in report");
    }, "provider", undefined, "start");
    expect((await finished()).status).toBe("succeeded");
  });

  it("arms a Timer immediately, lets the AI keep working, and invokes its follower in the same AI context", async () => {
    const { runner, definition, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("timer", "timer", { seconds: 0 }), block("extra", "text", { prompt: "extra work" })], [edge("start", "agent"), edge("agent", "timer", "use"), edge("timer", "agent"), edge("agent", "extra", "use")]);
    const events: string[] = [];
    const dispatch = vi.fn(async (_target, _prompt, runtime) => {
      await runtime.started("/sessions/agent");
      expect(await runner.flowTool(runtime.runId, "agent", "workflow_use_block", { block_id: "timer", input: "next cycle" })).toMatchObject({ blockId: "timer", status: "waiting", due_at: expect.any(String) });
      events.push("timer armed");
      expect(await runner.flowTool(runtime.runId, "agent", "workflow_use_block", { block_id: "extra", input: "now" })).toMatchObject({ output: "extra work" });
      events.push("extra work done"); return session("first cycle done");
    });
    const append = vi.fn(async (_target: HarnessBlock, prompt: string, runtime: { workspace: string }) => { expect(runtime.workspace).toBe("/sessions/agent"); expect(prompt).toContain("next cycle"); events.push("timer follower fired"); return session("second cycle done"); });
    await runner.start(definition.id, "start", dispatch, "provider", append, "start");
    expect((await finished()).status).toBe("succeeded"); expect(dispatch).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
    expect(events).toEqual(["timer armed", "extra work done", "timer follower fired"]);
    const traces = (await finished()).connectionTraces!;
    expect(traces.filter((trace) => trace.edgeId === "agent-timer-use").map((trace) => [trace.direction, trace.status])).toEqual([["forward", "succeeded"], ["return", "succeeded"]]);
    expect(traces.find((trace) => trace.edgeId === "timer-agent-follow")).toMatchObject({ direction: "forward", status: "succeeded" });
  });

  it("replaces a waiting Timer and passes the latest input to its followers", async () => {
    const { runner, definition, store, finished } = await setup([block("start", "start_input"), block("agent", "ai"), block("timer", "timer", { seconds: 300 }), block("after", "text")], [edge("start", "agent"), edge("agent", "timer", "use"), edge("timer", "after")]);
    const run = await runner.start(definition.id, "start", async (_target, _prompt, runtime) => {
      await runner.flowTool(runtime.runId, "agent", "workflow_use_block", { block_id: "timer", input: "old input" });
      const result = await runner.flowTool(runtime.runId, "agent", "workflow_use_block", { block_id: "timer", input: "latest input" }) as { due_at: string };
      expect(Date.parse(result.due_at) - Date.now()).toBeGreaterThan(299_000);
      return session("done");
    }, "provider", undefined, "start");
    await vi.waitFor(async () => expect((await store.runs())[0]?.blocks.find((state) => state.blockId === "agent")?.status).toBe("succeeded"));
    const timer = (await store.runs())[0]!.blocks.find((state) => state.blockId === "timer")!;
    expect((await store.runs())[0]?.blocks.find((state) => state.blockId === "after")?.status).toBe("queued");
    expect((await store.runs())[0]?.connectionTraces?.some((trace) => trace.edgeId === "timer-after-follow")).toBe(false);
    await runner.resumeTimer(run.id, "timer", timer.pauseId!, vi.fn());
    const result = await finished(); expect(result.status).toBe("succeeded"); expect(result.blocks.find((state) => state.blockId === "after")?.output).toBe("latest input");
  });

  it("allows a follow cycle through a Timer", async () => {
    const { definition } = await setup([block("start", "start_input"), block("agent", "ai"), block("timer", "timer", { seconds: 300 })], [edge("start", "agent"), edge("agent", "timer"), edge("timer", "agent")]);
    expect(validateHarness(definition).valid).toBe(true);
  });

});
