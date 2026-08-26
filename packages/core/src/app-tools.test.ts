import { describe, expect, it, vi } from "vitest";
import { AppToolService, appToolDefinitions } from "./app-tools.js";

function harness() {
  const task = { id: "task-1", name: "feature/one", branch: "feature/one", baseBranch: "main" };
  const tasks = {
    create: vi.fn(async () => task), createRandom: vi.fn(async () => task), delete: vi.fn(async () => ({ tasks: [] })),
    taskPath: vi.fn(() => "/tasks/task-1/workspace"), list: vi.fn(async () => ({ tasks: [task] }))
  };
  const session = { status: "in_progress", model: "gpt-5", messages: [{ id: "one", role: "assistant", text: "First", timestamp: "2026-01-01" }, { id: "two", role: "assistant", text: "Latest", timestamp: "2026-01-02" }], reasoning: "medium", configuration: { model: "gpt-5", reasoning: "medium" } };
  const provider = { send: vi.fn(async () => session), get: vi.fn(async () => session), steer: vi.fn(async () => session) };
  const acp = { get: vi.fn(() => provider), list: vi.fn(() => [{ id: "codex", name: "Codex" }]) };
  const onTasksChanged = vi.fn(async () => undefined);
  return { service: new AppToolService(tasks as never, acp as never, onTasksChanged), tasks, provider, task, onTasksChanged };
}

describe("Vibe Editor app tools", () => {
  it("publishes the requested task commands and provider/model parameters", () => {
    expect(appToolDefinitions.map((tool) => tool.name)).toEqual(["task_create", "task_create_and_start", "task_list", "task_delete", "task_ai_response_tail", "task_append_prompt"]);
    expect(appToolDefinitions[1].inputSchema.required).toEqual(["prompt", "provider", "model"]);
  });

  it("creates and starts a task with the requested provider and model", async () => {
    const { service, tasks, provider, task, onTasksChanged } = harness();
    await expect(service.call("task_create_and_start", { branch: "feature/one", prompt: "Implement it", provider: "codex", model: "gpt-5" }))
      .resolves.toEqual({ task, session: { status: "in_progress", model: "gpt-5" } });
    expect(tasks.create).toHaveBeenCalledWith("feature/one", false, false, false);
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { model: "gpt-5" } });
    expect(onTasksChanged).toHaveBeenCalledOnce();
  });

  it("lists aggregate and provider task status", async () => {
    const { service } = harness();
    await expect(service.call("task_list", {})).resolves.toMatchObject({ tasks: [{ id: "task-1", status: "in_progress", providers: { codex: "in_progress" } }] });
  });

  it("removes a task when its agent cannot be started", async () => {
    const { service, tasks, provider, onTasksChanged } = harness();
    provider.send.mockRejectedValueOnce(new Error("bad model"));
    await expect(service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "missing" })).rejects.toThrow("bad model");
    expect(tasks.delete).toHaveBeenCalledWith("task-1");
    expect(onTasksChanged).toHaveBeenCalledTimes(2);
  });

  it("deletes a task and notifies the editor", async () => {
    const { service, tasks, task, onTasksChanged } = harness();
    await expect(service.call("task_delete", { task_id: task.id })).resolves.toEqual({ deleted: task });
    expect(tasks.delete).toHaveBeenCalledWith(task.id);
    expect(onTasksChanged).toHaveBeenCalledOnce();
  });

  it("returns the requested number of latest AI messages", async () => {
    const { service } = harness();
    await expect(service.call("task_ai_response_tail", { task_id: "task-1", provider: "codex", messages: 1 })).resolves.toMatchObject({
      task_id: "task-1", provider: "codex", status: "in_progress", messages: [{ id: "two", text: "Latest" }]
    });
    await expect(service.call("task_ai_response_tail", { task_id: "task-1", provider: "codex", messages: 0 })).rejects.toThrow("messages must be an integer from 1 to 100");
  });

  it("steers a running task when appending a prompt", async () => {
    const { service, provider } = harness();
    await service.call("task_append_prompt", { task_id: "task-1", provider: "codex", prompt: "Also add tests" });
    expect(provider.steer).toHaveBeenCalledWith("/tasks/task-1/workspace", "Also add tests");
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("starts a follow-up turn when appending to a completed task", async () => {
    const { service, provider } = harness();
    provider.get.mockResolvedValueOnce({ status: "done", model: "gpt-5", reasoning: "high", configuration: { model: "gpt-5", reasoning: "high" }, messages: [] });
    await service.call("task_append_prompt", { task_id: "task-1", provider: "codex", prompt: "Fix the remaining issue" });
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Fix the remaining issue", configuration: { model: "gpt-5", reasoning: "high" } });
  });
});
