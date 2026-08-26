import { describe, expect, it, vi } from "vitest";
import { AppToolService, appToolDefinitions } from "./app-tools.js";

function harness() {
  const task = { id: "task-1", name: "feature/one", branch: "feature/one", baseBranch: "main" };
  const tasks = {
    create: vi.fn(async () => task), createRandom: vi.fn(async () => task), delete: vi.fn(async () => ({ tasks: [] })),
    taskPath: vi.fn(() => "/tasks/task-1/workspace"), list: vi.fn(async () => ({ tasks: [task] }))
  };
  const session = { status: "in_progress", model: "gpt-5", messages: [], reasoning: "medium" };
  const provider = { send: vi.fn(async () => session), get: vi.fn(async () => session) };
  const acp = { get: vi.fn(() => provider), list: vi.fn(() => [{ id: "codex", name: "Codex" }]) };
  const onTasksChanged = vi.fn(async () => undefined);
  return { service: new AppToolService(tasks as never, acp as never, onTasksChanged), tasks, provider, task, onTasksChanged };
}

describe("Vibe Editor app tools", () => {
  it("publishes the requested task commands and provider/model parameters", () => {
    expect(appToolDefinitions.map((tool) => tool.name)).toEqual(["task_create", "task_create_and_start", "task_list"]);
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
});
