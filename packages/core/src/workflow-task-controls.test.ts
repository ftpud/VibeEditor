import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock, WorkspaceTask } from "@remote-ide/protocol";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner } from "./harness-runner.js";
import { startWorkflow } from "./server.js";
import { executeTaskControls } from "./workflow-task-controls.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const session = (text: string): AiSession => ({ id: "session", status: "idle", model: "worker-model", reasoning: "high", configuration: { model: "worker-model", reasoning: "high" }, messages: [{ id: "reply", role: "assistant", text, timestamp: "now" }] } as AiSession);

async function setup(type: "ai" | "chatbox" = "ai") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-controls-")); directories.push(directory);
  const store = new HarnessStore("/root", directory);
  const runner = new HarnessRunner(store, () => {}, 1);
  const created = await store.create("Tasks");
  const controls: HarnessBlock = { id: "controls", type: "task_controls", label: "Task controls", prompt: "", provider: "worker", model: "worker-model", reasoning: "high", position: { x: 280, y: 0 } };
  const definition = await store.update({ ...created, blocks: [{ id: "agent", type, label: "Controller", prompt: "Manage tasks", position: { x: 0, y: 0 } }, controls], edges: [{ id: "use", from: "agent", to: "controls", type: "use" }] });
  const task: WorkspaceTask = { id: "task-1", name: "Example", branch: "feature/example", baseBranch: "main", status: "active", archived: false };
  const tasks = {
    list: vi.fn(async () => ({ tasks: [task] })), create: vi.fn(async () => task),
    taskPath: vi.fn(() => "/root/task-1"),
    setStatus: vi.fn(async (_id: string, status: WorkspaceTask["status"]) => { task.status = status; return { ...task }; })
  };
  const worker = {
    descriptor: { id: "worker", options: [] },
    get: vi.fn(async () => session("Prior response")), send: vi.fn(async () => session("Started")), steer: vi.fn(async () => session("Steered")),
    models: vi.fn(async () => [{ id: "worker-model", name: "Worker", defaultReasoning: "low", reasoningLevels: ["low", "high"] }])
  };
  const acp = { get: vi.fn((provider: string) => { if (provider !== "worker") throw new Error(`Unexpected provider ${provider}`); return worker; }), list: vi.fn(() => [{ id: "worker", name: "Worker" }]) };
  const context = { acp, tasks, agents: { list: vi.fn(async () => []) }, harnessRunner: runner, aiTimers: { next: vi.fn(async () => undefined) }, rootWorkspace: "/root", bridgeWorkspace: "/root", workspacePath: "/root", defaultProvider: "controller" } as unknown as Parameters<typeof executeTaskControls>[2];
  const runtime = { runId: "run", blockId: controls.id, assertActive: () => {}, started: async () => {}, activity: async () => {}, attemptId: "attempt", iteration: 1 } as Parameters<typeof executeTaskControls>[3];
  return { runner, store, controls, definition, context, runtime, worker, tasks, acp };
}

it.each(["ai", "chatbox"] as const)("attaches task controls to %s with fixed design settings and durable operations", async (type) => {
  const { runner, definition, context, worker, tasks, store } = await setup(type);
  const dispatch: Parameters<HarnessRunner["start"]>[2] = vi.fn(async (block, input, runtime) => {
    if (block.type === "task_controls") return executeTaskControls(block, input, context, runtime);
    const use = (args: Record<string, unknown>) => runner.flowTool(runtime.runId, block.id, "workflow_use_block", { block_id: "controls", ...args });
    const catalogue = await runner.flowTool(runtime.runId, block.id, "workflow_connections", {});
    expect(catalogue).toEqual([expect.objectContaining({ blockType: "task_controls", task_controls: { provider: "worker", model: "worker-model", reasoning: "high", actions: expect.arrayContaining(["create", "status", "prompt", "set_status"]) } })]);
    await expect(use({ block_id: "unconnected", action: "status" })).rejects.toThrow("connected block");
    await expect(use({ input: '{"action":"prompt","task_id":"task-1","prompt":"Override","provider":"controller"}' })).rejects.toThrow("AI settings come from the block design");
    expect(await use({ action: "create", branch: "feature/example", idempotency_key: "create-example" })).toMatchObject({ task_controls: { task: { id: "task-1" } } });
    await use({ action: "create", branch: "feature/example", idempotency_key: "create-example" });
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(await use({ action: "create_and_start", branch: "feature/started", input: "Implement", idempotency_key: "start-example" })).toMatchObject({ task_controls: { task: { id: "task-1" }, session: { status: "idle" } } });
    expect(worker.send).toHaveBeenLastCalledWith("/root/task-1", expect.objectContaining({ prompt: "Implement", configuration: { model: "worker-model", reasoning: "high" } }));
    expect(await use({ action: "prompt", task_id: "task-1", input: "Continue", idempotency_key: "continue-example" })).toMatchObject({ task_controls: { task_id: "task-1", provider: "worker" } });
    expect(worker.send).toHaveBeenLastCalledWith("/root/task-1", expect.objectContaining({ prompt: "Continue", configuration: { model: "worker-model", reasoning: "high" } }));
    expect(await use({ action: "status", task_id: "task-1" })).toMatchObject({ task_controls: { task: { task_status: "active", status: "idle", providers: { worker: "idle" } } } });
    await use({ action: "set_status", task_id: "task-1", status: "finished" });
    expect(await use({ action: "status" })).toMatchObject({ task_controls: { tasks: [expect.objectContaining({ task_status: "finished" })] } });
    await use({ action: "set_status", task_id: "task-1", status: "active" });
    return session("Tasks managed");
  });
  const run = await runner.start(definition.id, "Manage", dispatch, "controller");
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  const saved = (await store.runs())[0]!;
  expect(saved.children).toEqual([expect.objectContaining({ taskId: "task-1", provider: "worker", blockId: "controls", workspace: "/root/task-1" })]);
  expect(saved.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task_create", status: "succeeded" }), expect.objectContaining({ kind: "prompt_delivery", status: "succeeded" })]));
  expect((await store.read(definition.id)).blocks[1]).toMatchObject({ type: "task_controls", provider: "worker", model: "worker-model", reasoning: "high" });
});

it("lists tasks from direct empty input without needing an AI configuration", async () => {
  const { controls, context, runtime, worker } = await setup();
  context.harnessRunner.recordTool = vi.fn(async () => {});
  const reply = await executeTaskControls({ ...controls, model: "missing" }, "", context, runtime);
  expect(JSON.parse(reply.messages[0]!.text)).toMatchObject({ tasks: [expect.objectContaining({ task_status: "active" })] });
  expect(worker.models).not.toHaveBeenCalled();
  expect(worker.send).not.toHaveBeenCalled();
});

it("rejects malformed commands and unavailable design settings before creating a task", async () => {
  const { controls, context, runtime, tasks } = await setup();
  await expect(executeTaskControls(controls, "[]", context, runtime)).rejects.toThrow("JSON object");
  await expect(executeTaskControls(controls, '{"action":"delete"}', context, runtime)).rejects.toThrow("action must be");
  await expect(executeTaskControls({ ...controls, model: "missing" }, '{"action":"create_and_start","prompt":"Build"}', context, runtime)).rejects.toThrow("unavailable");
  await expect(executeTaskControls({ ...controls, reasoning: "unknown" }, '{"action":"create_and_start","prompt":"Build"}', context, runtime)).rejects.toThrow("unavailable");
  expect(tasks.create).not.toHaveBeenCalled();
});

it("routes direct Task controls runs through Core without starting a workflow agent", async () => {
  const { controls, context, definition, store, runner, worker } = await setup();
  const direct = await store.update({ ...definition, blocks: [controls], edges: [] });
  const run = await startWorkflow({ harnessId: direct.id, input: '{"action":"status"}', provider: "controller" }, { ...context, workflowApps: {} } as unknown as Parameters<typeof startWorkflow>[1]);
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  const output = (await runner.readRun(run.id))!.blocks[0]!.output!;
  expect(JSON.parse(output)).toMatchObject({ tasks: [expect.objectContaining({ task_status: "active", providers: { worker: "idle" } })] });
  expect(worker.send).not.toHaveBeenCalled();
  expect(worker.models).not.toHaveBeenCalled();
});
