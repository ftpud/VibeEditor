import crypto from "node:crypto";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { AppToolService } from "./app-tools.js";
import type { AcpRegistry } from "./ai/index.js";
import type { AgentsStore } from "./agents.js";
import type { AiTimerService } from "./ai-timers.js";
import type { HarnessRunner } from "./harness-runner.js";
import type { WorkspaceTaskStore } from "./tasks.js";

type Runtime = Parameters<Parameters<HarnessRunner["start"]>[2]>[2];
type Context = { acp: AcpRegistry; tasks: WorkspaceTaskStore; agents: AgentsStore; harnessRunner: HarnessRunner; aiTimers: AiTimerService; rootWorkspace: string; bridgeWorkspace: string; workspacePath: string; defaultProvider: string; onCommitMessageChanged?: (workspace: string, message: string) => Promise<void> };

/** Adapt the existing task MCP service to a workflow block with fixed AI settings. */
export async function executeTaskControls(block: HarnessBlock, input: string, context: Context, runtime: Runtime): Promise<AiSession> {
  runtime.assertActive();
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = input.trim() ? JSON.parse(input) : { action: "status" };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    request = parsed as Record<string, unknown>;
  } catch { throw new Error("Task controls input must be a JSON object with an action"); }
  if (Object.keys(request).some((key) => !["action", "prompt", "task_id", "branch", "status", "message", "idempotency_key"].includes(key))) throw new Error("Task controls accepts action, prompt, task_id, branch, status, message, and idempotency_key; AI settings come from the block design");
  const action = request.action ?? "status";
  if (!["create", "create_and_start", "status", "prompt", "set_status", "set_commit_message", "update_commit_message"].includes(String(action))) throw new Error("Task controls action must be create, create_and_start, status, prompt, set_status, set_commit_message, or update_commit_message");
  const { acp, tasks, agents, harnessRunner: runner, aiTimers, rootWorkspace, bridgeWorkspace, workspacePath } = context;
  const provider = block.provider ?? context.defaultProvider;
  const workflow = {
    runId: runtime.runId, blockId: block.id, flow: true, assertActive: runtime.assertActive,
    runStack: async () => { throw new Error("Task controls does not dispatch workflow stacks"); },
    registerChild: (taskId: string, childProvider: string, workspace: string) => runner.registerChild(runtime.runId, { taskId, provider: childProvider, workspace, blockId: block.id }),
    operation: <T>(kind: "timer_create" | "task_create" | "prompt_delivery" | "merge", key: string, args: unknown, effect: () => Promise<T>, reconcile?: () => Promise<T | null | undefined>) => runner.runOperation(runtime.runId, block.id, kind, key, args, effect, reconcile),
    recordTool: (name: string, args: Record<string, unknown>, result?: unknown, error?: unknown) => runner.recordTool(runtime.runId, block.id, name, args, result, error)
  };
  const onCommitMessageChanged = context.onCommitMessageChanged ?? ((workspace: string, message: string) => new AppEventBridge(bridgeWorkspace, undefined, appBridgeInstanceId).emit({ type: "commit-message.changed", workspace, message }));
  const service = new AppToolService(tasks, acp, workspacePath, undefined, onCommitMessageChanged, provider, agents, rootWorkspace, aiTimers, bridgeWorkspace, workflow);
  let result: unknown;
  if (action === "status") {
    const listed = await service.call("task_list", {}) as { tasks: Array<{ id: string }> };
    if (request.task_id !== undefined) {
      if (typeof request.task_id !== "string" || !request.task_id.trim()) throw new Error("task_id must be a nonempty string");
      const task = listed.tasks.find((task) => task.id === request.task_id);
      if (!task) throw new Error("Task does not exist");
      result = { task };
    } else result = listed;
  } else if (action === "create") {
    result = await service.call("task_create", { branch: request.branch, idempotency_key: request.idempotency_key });
  } else if (action === "set_status") {
    result = await service.call("task_set_status", { task_id: request.task_id, status: request.status });
  } else if (action === "set_commit_message" || action === "update_commit_message") {
    if (typeof request.task_id !== "string" || !request.task_id.trim()) throw new Error("Commit message actions require a task_id");
    result = await service.call(action === "set_commit_message" ? "set_commit_message" : "task_update_commit_message", { task_id: request.task_id, message: request.message === undefined ? request.prompt : request.message });
  } else {
    const manager = acp.get(provider);
    const models = await manager.models();
    const current = await manager.get(workspacePath);
    const model = block.model ?? models.find((item) => item.id === current.model && item.available !== false)?.id ?? models.find((item) => item.available !== false)?.id;
    const selected = models.find((item) => item.id === model && item.available !== false);
    if (!selected) throw new Error(`Task controls model '${model ?? "default"}' is unavailable for '${provider}'`);
    const reasoning = block.reasoning ?? selected.defaultReasoning;
    if (reasoning && !selected.reasoningLevels.includes(reasoning)) throw new Error(`Reasoning '${reasoning}' is unavailable for '${model}'`);
    result = await service.call(action === "create_and_start" ? "task_create_and_start" : "task_append_prompt", {
      ...(action === "create_and_start" ? { branch: request.branch, agent: null } : { task_id: request.task_id }),
      prompt: request.prompt, provider, model, ...(reasoning ? { reasoning } : {}), idempotency_key: request.idempotency_key
    });
  }
  runtime.assertActive();
  return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] } as AiSession;
}
