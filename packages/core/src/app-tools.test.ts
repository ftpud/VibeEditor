import { describe, expect, it, vi } from "vitest";
import type { AiSession } from "@remote-ide/acp";
import { AppToolService, appToolDefinitions } from "./app-tools.js";

function harness() {
  const task = { id: "task-1", name: "feature/one", branch: "feature/one", baseBranch: "main" };
  const tasks = {
    create: vi.fn(async () => task), createRandom: vi.fn(async () => task), delete: vi.fn(async () => ({ tasks: [] })),
    taskPath: vi.fn(() => "/tasks/task-1/workspace"), list: vi.fn(async () => ({ tasks: [task] })),
    setCommitMessage: vi.fn(async (_workspace: string, message: string) => ({ task, message, overwritten: false })),
    updateGitCommitMessage: vi.fn(async (_taskId: string, message: string) => ({
      task, previousCommit: "old-sha", commit: "new-sha", previousMessage: "Old message", message
    }))
  };
  const session: AiSession = { status: "in_progress", model: "gpt-5", messages: [{ id: "one", role: "assistant", text: "First", timestamp: "2026-01-01" }, { id: "two", role: "assistant", text: "Latest", timestamp: "2026-01-02" }], reasoning: "medium", configuration: { model: "gpt-5", reasoning: "medium", mode: "agent-full-access" } };
  const provider = {
    descriptor: { options: [{ id: "mode", name: "Agent mode", description: "", type: "select", defaultValue: "agent", choices: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Workspace agent" }, { value: "agent-full-access", name: "Full access" }] }] },
    send: vi.fn(async () => session), get: vi.fn(async () => session), steer: vi.fn(async () => session)
  };
  const acp = { get: vi.fn(() => provider), list: vi.fn(() => [{ id: "codex", name: "Codex" }]) };
  const onTasksChanged = vi.fn(async () => undefined);
  const onCommitMessageChanged = vi.fn(async () => undefined);
  return { service: new AppToolService(tasks as never, acp as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged), tasks, provider, task, onTasksChanged, onCommitMessageChanged };
}

describe("Vibe Editor app tools", () => {
  it("publishes the requested task commands and provider/model parameters", () => {
    expect(appToolDefinitions.map((tool) => tool.name)).toEqual(["task_create", "task_create_and_start", "task_list", "task_delete", "task_ai_response_tail", "task_append_prompt", "set_commit_message", "task_update_commit_message"]);
    expect(appToolDefinitions[1].inputSchema.required).toEqual(["prompt", "provider", "model"]);
    expect(appToolDefinitions[6]).toMatchObject({
      name: "set_commit_message",
      inputSchema: {
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S" } }
      }
    });
    expect(appToolDefinitions[7]).toMatchObject({
      name: "task_update_commit_message",
      inputSchema: {
        additionalProperties: false,
        required: ["task_id", "message"],
        properties: {
          task_id: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S" }
        }
      }
    });
  });

  it("creates and starts a task with the requested provider and model", async () => {
    const { service, tasks, provider, task, onTasksChanged } = harness();
    await expect(service.call("task_create_and_start", { branch: "feature/one", prompt: "Implement it", provider: "codex", model: "gpt-5" }))
      .resolves.toEqual({ task, session: { status: "in_progress", model: "gpt-5" } });
    expect(tasks.create).toHaveBeenCalledWith("feature/one", false, false, false);
    expect(provider.get).toHaveBeenCalledWith("/tasks/parent/workspace");
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent-full-access", model: "gpt-5" } });
    expect(onTasksChanged).toHaveBeenCalledOnce();
  });

  it("inherits disabled autopilot without inheriting the parent model", async () => {
    const { service, provider } = harness();
    provider.get.mockResolvedValueOnce({ status: "in_progress", model: "parent-model", reasoning: "high", configuration: { model: "parent-model", mode: "agent" }, messages: [] });
    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "child-model" });
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent", model: "child-model" } });
  });

  it("reads autopilot from the invoking provider while preserving the requested child provider", async () => {
    const { tasks, provider: child, onTasksChanged, onCommitMessageChanged } = harness();
    const parent = {
      ...child,
      get: vi.fn(async (): Promise<AiSession> => ({ status: "in_progress", model: "parent-model", reasoning: "high", configuration: { model: "parent-model", mode: "agent-full-access" }, messages: [] }))
    };
    const acp = { get: vi.fn((id: string) => id === "parent" ? parent : child), list: vi.fn(() => []) };
    const service = new AppToolService(tasks as never, acp as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "parent");

    await service.call("task_create_and_start", { prompt: "Implement it", provider: "child", model: "child-model" });

    expect(parent.get).toHaveBeenCalledWith("/tasks/parent/workspace");
    expect(child.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent-full-access", model: "child-model" } });
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

  it("sets and reports replacement of the current task commit message without committing", async () => {
    const { service, tasks, task, onCommitMessageChanged } = harness();
    await expect(service.call("set_commit_message", { message: "Add the first draft" })).resolves.toEqual({
      task_id: task.id, message: "Add the first draft", overwritten: false, committed: false
    });
    expect(tasks.setCommitMessage).toHaveBeenCalledWith("/tasks/parent/workspace", "Add the first draft");
    expect(onCommitMessageChanged).toHaveBeenCalledWith("/tasks/task-1/workspace", "Add the first draft");

    tasks.setCommitMessage.mockResolvedValueOnce({ task, message: "Replace the draft", overwritten: true });
    await expect(service.call("set_commit_message", { message: "Replace the draft" })).resolves.toMatchObject({ overwritten: true, committed: false });
  });

  it("preserves multiline commit messages verbatim", async () => {
    const { service, tasks } = harness();
    const message = "Subject\n\nDetailed body.\n  Indented detail\n";
    await service.call("set_commit_message", { message });
    expect(tasks.setCommitMessage).toHaveBeenCalledWith("/tasks/parent/workspace", message);
  });

  it("rejects missing, non-string, whitespace-only, and oversized commit messages", async () => {
    const { service, tasks } = harness();
    await expect(service.call("set_commit_message", {})).rejects.toThrow("message must contain at least one non-whitespace character");
    await expect(service.call("set_commit_message", { message: 42 })).rejects.toThrow("message must contain at least one non-whitespace character");
    await expect(service.call("set_commit_message", { message: " \n\t " })).rejects.toThrow("message must contain at least one non-whitespace character");
    await expect(service.call("set_commit_message", { message: "x".repeat(10_001) })).rejects.toThrow("message must be at most 10000 characters");
    expect(tasks.setCommitMessage).not.toHaveBeenCalled();
  });

  it("updates the Git commit message for an explicit task and returns rewrite details", async () => {
    const { service, tasks, task } = harness();
    const message = "New subject\n\nNew body";
    await expect(service.call("task_update_commit_message", { task_id: task.id, message })).resolves.toEqual({
      task_id: task.id, branch: task.branch, previous_commit: "old-sha", commit: "new-sha",
      previous_message: "Old message", message, rewritten: true
    });
    expect(tasks.updateGitCommitMessage).toHaveBeenCalledWith(task.id, message);
    await expect(service.call("task_update_commit_message", { task_id: " ", message })).rejects.toThrow("task_id must be a non-empty string");
    await expect(service.call("task_update_commit_message", { task_id: task.id, message: " \n " })).rejects.toThrow("message must contain at least one non-whitespace character");
  });
});
