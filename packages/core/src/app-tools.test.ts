import { describe, expect, it, vi } from "vitest";
import type { AiSession, AiUsage } from "@remote-ide/acp";
import type { AgentFile } from "@remote-ide/protocol";
import { AppToolService, appToolDefinitions } from "./app-tools.js";
import { agentFingerprint } from "./agent-profile.js";

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
    send: vi.fn(async () => session), get: vi.fn(async () => session), steer: vi.fn(async () => session), configureNext: vi.fn(async (_workspace: string, configuration: Record<string, string>) => ({ ...session, nextConfiguration: configuration })),
    usage: vi.fn(async (): Promise<AiUsage> => ({ supported: true, label: "Context window", used: 120, limit: 1000, unit: "tokens" })),
    models: vi.fn(async () => [{ id: "gpt-5", name: "GPT-5", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"] }, { id: "child-model", name: "Child", defaultReasoning: "low", reasoningLevels: ["low", "high"] }, { id: "unavailable", name: "Unavailable", available: false, defaultReasoning: "low", reasoningLevels: ["low"] }])
  };
  const acp = { get: vi.fn(() => provider), list: vi.fn(() => [{ id: "codex", name: "Codex" }]) };
  const agents = { list: vi.fn(async (): Promise<AgentFile[]> => []) };
  const onTasksChanged = vi.fn(async () => undefined);
  const onCommitMessageChanged = vi.fn(async () => undefined);
  return { service: new AppToolService(tasks as never, acp as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, undefined, agents as never, "/workspace"), tasks, provider, agents, task, onTasksChanged, onCommitMessageChanged };
}

describe("Vibe Editor app tools", () => {
  it("publishes task start agent and reasoning parameters", () => {
    expect(appToolDefinitions.map((tool) => tool.name)).toEqual(["ai_usage", "timer_set", "model_switch_next", "task_create", "task_create_and_start", "task_list", "task_delete", "task_ai_response_tail", "task_append_prompt", "set_commit_message", "task_update_commit_message"]);
    expect(appToolDefinitions[1]).toMatchObject({ name: "timer_set", inputSchema: { required: ["seconds", "prompt"] } });
    expect(appToolDefinitions[2]).toMatchObject({ name: "model_switch_next", inputSchema: { required: ["model", "reasoning"] } });
    expect(appToolDefinitions[4].inputSchema.required).toEqual(["prompt", "provider", "model"]);
    expect(appToolDefinitions[4].inputSchema.properties.agent).toMatchObject({
      oneOf: [{ type: "object", required: ["scope", "name"] }, { type: "null" }]
    });
    expect(appToolDefinitions[4].inputSchema.properties.reasoning).toMatchObject({ type: "string", minLength: 1 });
    expect(appToolDefinitions[9]).toMatchObject({
      name: "set_commit_message",
      inputSchema: {
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S" } }
      }
    });
    expect(appToolDefinitions[10]).toMatchObject({
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

  it("queues a validated model and reasoning override for the next turn", async () => {
    const { tasks, provider, onTasksChanged, onCommitMessageChanged, agents } = harness();
    const service = new AppToolService(tasks as never, { get: vi.fn(() => provider), list: vi.fn(() => []) } as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "codex", agents as never, "/workspace");
    await expect(service.call("model_switch_next", { model: "gpt-5", reasoning: "high" })).resolves.toEqual({ provider: "codex", model: "gpt-5", reasoning: "high", applies_to: "next_turn" });
    expect(provider.configureNext).toHaveBeenCalledWith("/tasks/parent/workspace", { model: "gpt-5", reasoning: "high" });
  });

  it("rejects an unadvertised next-turn model or reasoning without queuing it", async () => {
    const { tasks, provider, onTasksChanged, onCommitMessageChanged } = harness();
    const service = new AppToolService(tasks as never, { get: vi.fn(() => provider), list: vi.fn(() => []) } as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "codex");
    await expect(service.call("model_switch_next", { model: "missing", reasoning: "high" })).rejects.toThrow("Model 'missing' is not advertised");
    await expect(service.call("model_switch_next", { model: "unavailable", reasoning: "low" })).rejects.toThrow("is not available for the selected provider account");
    await expect(service.call("model_switch_next", { model: "gpt-5", reasoning: "ultra" })).rejects.toThrow("supported values: low, medium, high");
    expect(provider.configureNext).not.toHaveBeenCalled();
  });

  it("sets a continuation timer for the invoking provider", async () => {
    const { tasks, provider, onTasksChanged, onCommitMessageChanged, agents } = harness();
    const timer = { id: "timer-1", workspace: "/tasks/parent/workspace", provider: "codex", prompt: "Check again", createdAt: "2026-08-30T12:00:00.000Z", dueAt: "2026-08-30T12:00:30.000Z" };
    const timers = { schedule: vi.fn(async () => timer), next: vi.fn(async () => undefined) };
    const service = new AppToolService(tasks as never, { get: vi.fn(() => provider), list: vi.fn(() => []) } as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "codex", agents as never, "/workspace", timers as never);

    await expect(service.call("timer_set", { seconds: 30, prompt: "Check again" })).resolves.toEqual({ timer_id: "timer-1", status: "waiting", due_at: timer.dueAt, continuation_prompt: "Check again" });
    expect(timers.schedule).toHaveBeenCalledWith("/tasks/parent/workspace", "codex", "Check again", 30);
  });

  it("reports usage and computes remaining capacity for the invoking provider", async () => {
    const { tasks, provider, onTasksChanged, onCommitMessageChanged } = harness();
    const acp = { get: vi.fn(() => provider), list: vi.fn(() => []) };
    const service = new AppToolService(tasks as never, acp as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "codex");

    await expect(service.call("ai_usage", {})).resolves.toMatchObject({
      provider: "codex", supported: true, kind: "context_window", used: 120, limit: 1000,
      remaining: 880, unit: "tokens", resets_at: null
    });
    expect(provider.usage).toHaveBeenCalledWith("/tasks/parent/workspace");
  });

  it("preserves provider reset timestamps and accepts an explicit provider", async () => {
    const { service, provider } = harness();
    provider.usage.mockResolvedValueOnce({ supported: true, label: "Plan quota", used: 80, limit: 100, unit: "percent", resetsAt: "2026-09-01T12:00:00.000Z" });
    await expect(service.call("ai_usage", { provider: "copilot" })).resolves.toMatchObject({
      provider: "copilot", kind: "provider_usage", remaining: 20, resets_at: "2026-09-01T12:00:00.000Z"
    });
  });

  it("reports account quota separately from context usage", async () => {
    const { service, provider } = harness();
    provider.usage.mockResolvedValueOnce({
      supported: true, label: "Context window", used: 120, limit: 1000, unit: "tokens",
      accountQuota: { plan: "plus", primary: { usedPercent: 27, remainingPercent: 73, windowMinutes: 300, resetsAt: "2026-08-30T13:55:22.000Z" } }
    });
    await expect(service.call("ai_usage", { provider: "codex" })).resolves.toMatchObject({
      kind: "context_window", remaining: 880,
      account_quota: { plan: "plus", primary: { used_percent: 27, remaining_percent: 73, window_minutes: 300, resets_at: "2026-08-30T13:55:22.000Z" } }
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

  it("applies a configured agent preset by scope and file name", async () => {
    const { service, provider, agents } = harness();
    const reviewer = { name: "Reviewer", instructions: "Review carefully." };
    agents.list.mockResolvedValueOnce([{ scope: "workspace", name: "reviewer.md", agent: reviewer }]);

    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5", agent: { scope: "workspace", name: "reviewer.md" } });

    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", expect.objectContaining({ agent: reviewer }));
  });

  it("inherits the invoking session's configured agent when agent is omitted", async () => {
    const { service, provider, agents } = harness();
    const coordinator = { name: "Coordinator", instructions: "Coordinate tasks.", mcpServers: ["vibe-editor"] };
    provider.get.mockResolvedValueOnce({ ...await provider.get(), agent: { name: coordinator.name, fingerprint: agentFingerprint(coordinator) } });
    agents.list.mockResolvedValueOnce([{ scope: "global", name: "coordinator.md", agent: coordinator }]);

    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5" });

    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", expect.objectContaining({ agent: coordinator, mcpServers: [expect.objectContaining({ name: "vibe-editor" })] }));
  });

  it("uses explicit null to suppress inherited agent instructions", async () => {
    const { service, provider, agents } = harness();
    const coordinator = { name: "Coordinator", instructions: "Coordinate tasks." };
    provider.get.mockResolvedValueOnce({ ...await provider.get(), agent: { name: coordinator.name, fingerprint: agentFingerprint(coordinator) } });
    agents.list.mockResolvedValueOnce([{ scope: "global", name: "coordinator.md", agent: coordinator }]);

    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5", agent: null });

    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent-full-access", model: "gpt-5" } });
    expect(agents.list).not.toHaveBeenCalled();
  });

  it("forwards an advertised reasoning effort", async () => {
    const { service, provider } = harness();
    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5", reasoning: "high" });
    expect(provider.models).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent-full-access", model: "gpt-5", reasoning: "high" } });
  });

  it("rejects reasoning not advertised for the selected model before creating a task", async () => {
    const { service, tasks, provider } = harness();
    await expect(service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5", reasoning: "extreme" }))
      .rejects.toThrow("reasoning 'extreme' is not supported by model 'gpt-5'; supported values: low, medium, high");
    expect(tasks.createRandom).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("omits reasoning to preserve the provider/model default", async () => {
    const { service, provider } = harness();
    await service.call("task_create_and_start", { prompt: "Implement it", provider: "codex", model: "gpt-5" });
    expect(provider.models).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledWith("/tasks/task-1/workspace", { prompt: "Implement it", configuration: { mode: "agent-full-access", model: "gpt-5" } });
  });

  it("reads autopilot from the invoking provider while preserving the requested child provider", async () => {
    const { tasks, provider: child, onTasksChanged, onCommitMessageChanged } = harness();
    const parent = {
      ...child,
      get: vi.fn(async (): Promise<AiSession> => ({ status: "in_progress", model: "parent-model", reasoning: "high", configuration: { model: "parent-model", mode: "agent-full-access" }, messages: [] }))
    };
    const acp = { get: vi.fn((id: string) => id === "parent" ? parent : child), list: vi.fn(() => []) };
    const service = new AppToolService(tasks as never, acp as never, "/tasks/parent/workspace", onTasksChanged, onCommitMessageChanged, "parent", { list: vi.fn(async () => []) } as never, "/workspace");

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
