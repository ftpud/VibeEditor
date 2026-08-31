import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { findAutopilotOption, type AiAgent, type AiConfiguration, type AiMcpServer, type AiModel, type AiOption, type AiProvider, type AiQuotaWindow, type AiSession, type AiUsage } from "@remote-ide/acp";
import type { AgentFileReference } from "@remote-ide/protocol";
import { WorkspaceTaskStore, type WorkspaceTask } from "./tasks.js";
import type { AcpRegistry } from "./ai/index.js";
import { summarizeAiSessions } from "./ai/summary.js";
import { AppEventBridge } from "./app-events.js";
import type { AgentsStore } from "./agents.js";
import { agentFingerprint } from "./agent-profile.js";
import type { AiTimerService } from "./ai-timers.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function requiredTaskStatus(args: Record<string, unknown>): WorkspaceTask["status"] {
  const status = requiredString(args, "status");
  if (status !== "active" && status !== "finished") throw new Error("status must be active or finished");
  return status;
}

export const appToolDefinitions = [
  {
    name: "ai_usage",
    description: "Report the current AI session's token usage, remaining reported capacity, and reset time when the provider exposes one. Context-window capacity and account quota are identified separately.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { provider: { type: "string", description: "AI provider id. Omit to use the provider running this agent." } }
    }
  },
  {
    name: "timer_set",
    description: "Set or replace a timer for this agent. After the requested number of seconds, Vibe Editor sends the continuation prompt back to this task's AI session.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        seconds: { type: "integer", minimum: 1, maximum: 604800, description: "Delay in whole seconds, from 1 second to 7 days." },
        prompt: { type: "string", minLength: 1, maxLength: 10000, description: "Continuation prompt to send when the timer expires." }
      },
      required: ["seconds", "prompt"]
    }
  },
  {
    name: "model_switch_next",
    description: "Use a provider-advertised model and reasoning effort for exactly the next new task turn in this AI session. When called during a running turn, automatically queue a continuation so the selection is exercised after the current turn; it never changes the current turn. A later call replaces the pending selection.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1, description: "Model id advertised by the provider running this agent." },
        reasoning: { type: "string", minLength: 1, description: "Reasoning effort advertised for that model." }
      },
      required: ["model", "reasoning"]
    }
  },
  {
    name: "session_new",
    description: "After this turn, archive the current conversation, start a new empty session in the same workspace/provider, and send a handoff prompt as its first message.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { prompt: { type: "string", minLength: 1, maxLength: 10000, description: "Self-contained handoff prompt for the fresh session." } },
      required: ["prompt"]
    }
  },
  {
    name: "task_create",
    description: "Create an isolated Vibe Editor task worktree without starting an agent.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { branch: { type: "string", description: "Git branch name for the task." } },
      required: ["branch"]
    }
  },
  {
    name: "task_create_and_start",
    description: "Create an isolated Vibe Editor task and start a provider/model session in it, optionally selecting an agent preset and reasoning effort.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        branch: { type: "string", description: "Git branch name for the task. Omit to generate one." },
        prompt: { type: "string", description: "Work to give the new task's AI session." },
        provider: { type: "string", description: "AI provider id, for example codex or copilot." },
        model: { type: "string", description: "Model id supported by the selected provider." },
        agent: {
          oneOf: [
            {
              type: "object", additionalProperties: false,
              properties: {
                scope: { type: "string", enum: ["global", "local", "workspace"], description: "Configured agent-preset scope." },
                name: { type: "string", minLength: 1, description: "Agent preset Markdown file name, for example reviewer.md." }
              },
              required: ["scope", "name"]
            },
            { type: "null" }
          ],
          description: "Configured agent preset to apply. Omit to inherit the invoking session's preset; pass null to start with no agent preset. This does not select the AI provider."
        },
        reasoning: { type: "string", minLength: 1, description: "Reasoning effort advertised for the selected model, for example low, medium, or high. Omit to use the provider/model default." }
      },
      required: ["prompt", "provider", "model"]
    }
  },
  {
    name: "task_list",
    description: "List Vibe Editor tasks and their current aggregate and per-provider AI status.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "task_delete",
    description: "Delete a Vibe Editor task, its worktree, and its task branch.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { task_id: { type: "string", description: "Task id returned by task_create or task_list." } },
      required: ["task_id"]
    }
  },
  {
    name: "task_set_status",
    description: "Mark a Vibe Editor task as finished or restore it to active.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create or task_list." },
        status: { type: "string", enum: ["active", "finished"], description: "Set finished when the task is complete; set active to restore it." }
      },
      required: ["task_id", "status"]
    }
  },
  {
    name: "task_ai_response_tail",
    description: "Return the latest messages from a task's AI conversation.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create or task_list." },
        provider: { type: "string", description: "AI provider whose conversation should be read." },
        messages: { type: "integer", minimum: 1, maximum: 100, description: "Number of latest messages to return." }
      },
      required: ["task_id", "provider", "messages"]
    }
  },
  {
    name: "task_append_prompt",
    description: "Append a prompt to a task's AI conversation. Steers a running turn or starts a follow-up turn after completion.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create or task_list." },
        provider: { type: "string", description: "AI provider that owns the task conversation." },
        prompt: { type: "string", description: "Follow-up instructions for the task's agent." }
      },
      required: ["task_id", "provider", "prompt"]
    }
  },
  {
    name: "set_commit_message",
    description: "Set or replace the Git commit message draft for the current Vibe Editor task. Preserves multiline text and does not create a commit.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Commit message draft. May contain multiple lines; must contain at least one non-whitespace character." }
      },
      required: ["message"]
    }
  },
  {
    name: "task_update_commit_message",
    description: "Rewrite the latest unpushed commit message on a specific Vibe Editor task branch. Does not change commit contents or working-tree changes and refuses unsafe published-history rewrites.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        task_id: { type: "string", minLength: 1, description: "Task id returned by task_create or task_list." },
        message: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "New Git commit message. May contain multiple lines; must contain at least one non-whitespace character." }
      },
      required: ["task_id", "message"]
    }
  }
] as const;

export class AppToolService {
  constructor(
    private readonly tasks: WorkspaceTaskStore,
    private readonly acp: AcpRegistry,
    private readonly currentWorkspace: string,
    private readonly onTasksChanged: () => Promise<void> = async () => undefined,
    private readonly onCommitMessageChanged: (workspace: string, message: string) => Promise<void> = async () => undefined,
    private readonly currentProvider?: AiProvider,
    private readonly agents?: Pick<AgentsStore, "list">,
    private readonly rootWorkspace?: string,
    private readonly timers?: Pick<AiTimerService, "schedule" | "next" | "cancelWorkspace">
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "ai_usage") {
      const provider = optionalString(args, "provider") ?? this.currentProvider;
      if (!provider) throw new Error("provider is required when the invoking AI provider is not known");
      return usageResult(provider, await this.acp.get(provider).usage(this.currentWorkspace));
    }
    if (name === "timer_set") {
      if (!this.timers) throw new Error("Continuation timers are not available");
      if (!this.currentProvider) throw new Error("provider is required when the invoking AI provider is not known");
      const prompt = requiredString(args, "prompt");
      if (prompt.length > 10_000) throw new Error("prompt must be at most 10000 characters");
      const timer = await this.timers.schedule(this.currentWorkspace, this.currentProvider, prompt, requiredInteger(args, "seconds", 1, 604_800));
      return { timer_id: timer.id, status: "waiting", due_at: timer.dueAt, continuation_prompt: timer.prompt };
    }
    if (name === "model_switch_next") {
      if (!this.currentProvider) throw new Error("model switching requires a known invoking AI provider");
      const model = requiredString(args, "model");
      const reasoning = requiredString(args, "reasoning");
      const manager = this.acp.get(this.currentProvider);
      await validateReasoning(await manager.models(), model, reasoning);
      const current = await manager.get(this.currentWorkspace);
      await manager.configureNext(this.currentWorkspace, { model, reasoning });
      await manager.steer(this.currentWorkspace, "Continue the current task using the newly selected model and reasoning effort.", { senderModel: current.model, queue: true });
      return { provider: this.currentProvider, model, reasoning, applies_to: "next_turn", continuation: "queued" };
    }
    if (name === "session_new") {
      if (!this.currentProvider) throw new Error("starting a fresh session requires a known invoking AI provider");
      const prompt = requiredString(args, "prompt");
      if (prompt.length > 10_000) throw new Error("prompt must be at most 10000 characters");
      const manager = this.acp.get(this.currentProvider);
      const current = await manager.get(this.currentWorkspace);
      const selectedAgent = await this.resolveAgent(undefined, current);
      const appTools = this.rootWorkspace ? withAppTools(this.rootWorkspace, this.currentWorkspace, [], selectedAgent, this.currentProvider) : { servers: [], agent: selectedAgent };
      const session = await manager.startFreshSession(this.currentWorkspace, { prompt, configuration: current.configuration ?? { model: current.model, reasoning: current.reasoning }, ...(appTools.servers.length ? { mcpServers: appTools.servers } : {}), ...(appTools.agent ? { agent: appTools.agent } : {}) });
      return { provider: this.currentProvider, workspace: this.currentWorkspace, status: session.status, transition: "queued", prompt };
    }
    if (name === "task_create") {
      const task = await this.tasks.create(requiredString(args, "branch"), false, false, false);
      await this.onTasksChanged();
      return { task };
    }
    if (name === "task_create_and_start") {
      const prompt = requiredString(args, "prompt");
      const provider = requiredString(args, "provider") as AiProvider;
      const model = requiredString(args, "model");
      const branch = optionalString(args, "branch");
      const requestedAgent = agentReference(args);
      const reasoning = optionalString(args, "reasoning");
      const manager = this.acp.get(provider);
      const parentManager = this.acp.get(this.currentProvider ?? provider);
      const parent = await parentManager.get(this.currentWorkspace);
      const selectedAgent = await this.resolveAgent(requestedAgent, parent);
      if (reasoning !== undefined) await validateReasoning(await manager.models(), model, reasoning);
      const configuration: AiConfiguration = { ...inheritedAutopilot(parentManager.descriptor.options, parent, manager.descriptor.options), model, ...(reasoning !== undefined ? { reasoning } : {}) };
      const task = branch ? await this.tasks.create(branch, false, false, false) : await this.tasks.createRandom(false);
      await this.onTasksChanged();
      try {
        const workspace = this.tasks.taskPath(task.id);
        const appTools = this.rootWorkspace ? withAppTools(this.rootWorkspace, workspace, [], selectedAgent, provider) : { servers: [], agent: selectedAgent };
        const session = await manager.send(workspace, { prompt, configuration, ...(appTools.servers.length > 0 ? { mcpServers: appTools.servers } : {}), ...(appTools.agent ? { agent: appTools.agent } : {}) });
        return { task, session: { status: session.status, model: session.model } };
      } catch (error) {
        await this.tasks.delete(task.id).catch(() => undefined);
        await this.onTasksChanged().catch(() => undefined);
        throw error;
      }
    }
    if (name === "task_list") {
      const registry = await this.tasks.list();
      const providers = this.acp.list();
      const tasks = await Promise.all(registry.tasks.map(async (task) => ({ ...task, ...await this.status(task) })));
      return { tasks };
    }
    if (name === "task_delete") {
      const task = await this.task(requiredString(args, "task_id"));
      await this.timers?.cancelWorkspace(this.tasks.taskPath(task.id));
      await this.tasks.delete(task.id);
      await this.onTasksChanged();
      return { deleted: task };
    }
    if (name === "task_set_status") {
      const task = await this.tasks.setStatus(requiredString(args, "task_id"), requiredTaskStatus(args));
      await this.onTasksChanged();
      return { task };
    }
    if (name === "task_ai_response_tail") {
      const task = await this.task(requiredString(args, "task_id"));
      const provider = requiredString(args, "provider") as AiProvider;
      const count = requiredInteger(args, "messages", 1, 100);
      const session = await this.acp.get(provider).get(this.tasks.taskPath(task.id));
      return {
        task_id: task.id, provider, status: session.status,
        messages: session.messages.slice(-count).map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp }))
      };
    }
    if (name === "task_append_prompt") {
      const task = await this.task(requiredString(args, "task_id"));
      const provider = requiredString(args, "provider") as AiProvider;
      const prompt = requiredString(args, "prompt");
      const manager = this.acp.get(provider);
      const workspace = this.tasks.taskPath(task.id);
      const current = await manager.get(workspace);
      const session = current.status === "in_progress" || current.status === "user_prompt"
        ? await manager.steer(workspace, prompt)
        : await manager.send(workspace, { prompt, configuration: current.configuration ?? { model: current.model, reasoning: current.reasoning } });
      return { task_id: task.id, provider, session: { status: session.status, model: session.model } };
    }
    if (name === "set_commit_message") {
      const message = requiredCommitMessage(args, "message");
      const update = await this.tasks.setCommitMessage(this.currentWorkspace, message);
      const workspace = this.tasks.taskPath(update.task.id);
      await this.onCommitMessageChanged(workspace, message);
      return { task_id: update.task.id, message: update.message, overwritten: update.overwritten, committed: false };
    }
    if (name === "task_update_commit_message") {
      const taskId = requiredString(args, "task_id");
      const message = requiredCommitMessage(args, "message");
      const update = await this.tasks.updateGitCommitMessage(taskId, message);
      return {
        task_id: update.task.id, branch: update.task.branch, previous_commit: update.previousCommit,
        commit: update.commit, previous_message: update.previousMessage, message: update.message, rewritten: true
      };
    }
    throw new Error(`Unknown tool '${name}'`);
  }

  private async task(id: string): Promise<WorkspaceTask> {
    const task = (await this.tasks.list()).tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Task '${id}' does not exist`);
    return task;
  }

  private async status(task: WorkspaceTask) {
    const sessions = await Promise.all(this.acp.list().map((provider) => this.acp.get(provider.id).get(this.tasks.taskPath(task.id))));
    const summary = summarizeAiSessions(sessions);
    const timer = await this.timers?.next(this.tasks.taskPath(task.id));
    return { ...summary, ...(timer && summary.status !== "in_progress" && summary.status !== "user_prompt" ? { status: "waiting", waiting_until: timer.dueAt } : {}), providers: Object.fromEntries(this.acp.list().map((provider, index) => [provider.id, sessions[index]!.status])) };
  }

  private async resolveAgent(requested: AgentFileReference | null | undefined, parent: AiSession): Promise<AiAgent | undefined> {
    if (requested === null) return undefined;
    if (!this.agents) {
      if (requested !== undefined || parent.agent) throw new Error("Agent presets are not available");
      return undefined;
    }
    const configured = await this.agents.list(this.currentWorkspace);
    if (requested) {
      const match = configured.find((file) => file.scope === requested.scope && file.name === requested.name);
      if (!match) throw new Error(`Agent preset '${requested.scope}:${requested.name}' does not exist`);
      return match.agent;
    }
    if (!parent.agent) return undefined;
    const inherited = configured.find((file) => file.agent.name === parent.agent!.name && agentFingerprint(file.agent) === parent.agent!.fingerprint);
    if (!inherited) throw new Error(`Invoking agent preset '${parent.agent.name}' is no longer available; pass agent: null to start without it`);
    return inherited.agent;
  }
}

function usageResult(provider: AiProvider, usage: AiUsage) {
  const remaining = usage.used !== undefined && usage.limit !== undefined ? Math.max(0, usage.limit - usage.used) : undefined;
  return {
    provider,
    supported: usage.supported,
    kind: usage.label === "Context window" ? "context_window" : "provider_usage",
    label: usage.label ?? null,
    used: usage.used ?? null,
    limit: usage.limit ?? null,
    remaining: remaining ?? null,
    unit: usage.unit ?? null,
    resets_at: usage.resetsAt ?? null,
    details: usage.details ?? {},
    account_quota: usage.accountQuota ? {
      plan: usage.accountQuota.plan ?? null,
      limit_id: usage.accountQuota.limitId ?? null,
      limit_name: usage.accountQuota.limitName ?? null,
      primary: usage.accountQuota.primary ? quotaWindowResult(usage.accountQuota.primary) : null,
      secondary: usage.accountQuota.secondary ? quotaWindowResult(usage.accountQuota.secondary) : null,
      credits: usage.accountQuota.credits ? {
        has_credits: usage.accountQuota.credits.hasCredits,
        unlimited: usage.accountQuota.credits.unlimited,
        balance: usage.accountQuota.credits.balance ?? null
      } : null
    } : null,
    note: usage.accountQuota === undefined
      ? "This provider has not exposed a quota reset time through ACP. A context-window limit is conversation capacity, not an account rate-limit quota."
      : undefined
  };
}

function quotaWindowResult(window: AiQuotaWindow) {
  return { used_percent: window.usedPercent, remaining_percent: window.remainingPercent, window_minutes: window.windowMinutes ?? null, resets_at: window.resetsAt ?? null };
}

type AgentArgument = AgentFileReference | null | undefined;

function agentReference(args: Record<string, unknown>): AgentArgument {
  if (!("agent" in args)) return undefined;
  const value = args.agent;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent must be a configured agent reference or null");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "scope" && key !== "name")) throw new Error("agent contains unsupported properties");
  if (record.scope !== "global" && record.scope !== "local" && record.scope !== "workspace") throw new Error("agent.scope must be global, local, or workspace");
  return { scope: record.scope, name: requiredString(record, "name") };
}

async function validateReasoning(models: AiModel[], modelId: string, reasoning: string): Promise<void> {
  const model = models.find((item) => item.id === modelId);
  if (!model) throw new Error(`Model '${modelId}' is not advertised by the selected provider`);
  if (model.available === false) throw new Error(`Model '${modelId}' is advertised but is not available for the selected provider account`);
  if (!model.reasoningLevels.includes(reasoning)) {
    const supported = model.reasoningLevels.length > 0 ? model.reasoningLevels.join(", ") : "none (omit reasoning to use this model)";
    throw new Error(`reasoning '${reasoning}' is not supported by model '${modelId}'; supported values: ${supported}`);
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  return requiredString(args, key);
}

function requiredInteger(args: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}

function requiredCommitMessage(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must contain at least one non-whitespace character`);
  if (value.length > 10_000) throw new Error(`${key} must be at most 10000 characters`);
  return value;
}

async function main() {
  const rootWorkspace = process.env.VIBE_EDITOR_ROOT_WORKSPACE;
  if (!rootWorkspace) throw new Error("VIBE_EDITOR_ROOT_WORKSPACE is required");
  const currentWorkspace = process.env.VIBE_EDITOR_CURRENT_WORKSPACE;
  if (!currentWorkspace) throw new Error("VIBE_EDITOR_CURRENT_WORKSPACE is required");
  const currentProvider = process.env.VIBE_EDITOR_CURRENT_PROVIDER;
  const bridge = new AppEventBridge(rootWorkspace);
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) continue;
    try {
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vibe-editor", version: "0.1.0" } };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: appToolDefinitions };
      else if (request.method === "tools/call") {
        const params = request.params ?? {};
        const value = await bridge.call({ name: requiredString(params, "name"), args: (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>, currentWorkspace, ...(currentProvider ? { currentProvider } : {}) });
        result = toolResult(value);
      } else throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.method === "tools/call") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: toolResult(message, true) })}\n`);
      else process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: (error as { code?: number }).code ?? -32603, message } })}\n`);
    }
  }
}

function toolResult(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function inheritedAutopilot(parentOptions: AiOption[], parent: AiSession, childOptions: AiOption[]): AiConfiguration {
  const effectiveParentOptions = [...parentOptions.filter((option) => !parent.availableOptions?.some((candidate) => candidate.id === option.id)), ...(parent.availableOptions ?? [])];
  const parentAutopilot = findAutopilotOption(effectiveParentOptions);
  if (!parentAutopilot) return {};
  const parentValue = parent.configuration?.[parentAutopilot.option.id] ?? parentAutopilot.option.defaultValue;
  const enabled = String(parentValue) === String(parentAutopilot.on);
  const childAutopilot = findAutopilotOption(childOptions) ?? parentAutopilot;
  return { [childAutopilot.option.id]: enabled ? childAutopilot.on : childAutopilot.off };
}

export function withAppTools(rootWorkspace: string, currentWorkspace: string, servers?: AiMcpServer[], agent?: AiAgent, currentProvider?: AiProvider): { servers: AiMcpServer[]; agent?: AiAgent } {
  if (!agent?.mcpServers?.includes("vibe-editor")) return { servers: servers ?? [], ...(agent ? { agent } : {}) };
  const appServer = appToolServer(rootWorkspace, currentWorkspace, currentProvider);
  const filtered = (servers ?? []).filter((server) => server.name !== appServer.name);
  return { servers: [...filtered, appServer], agent };
}

export function appToolServer(rootWorkspace: string, currentWorkspace: string, currentProvider?: AiProvider): AiMcpServer {
  const compiled = fileURLToPath(new URL("app-tools.js", import.meta.url));
  const source = fileURLToPath(new URL("app-tools.ts", import.meta.url));
  const runningFromSource = import.meta.url.endsWith("/src/app-tools.ts");
  return runningFromSource
    ? { transport: "stdio", name: "vibe-editor", command: process.execPath, args: ["--import", "tsx", source], env: { VIBE_EDITOR_ROOT_WORKSPACE: rootWorkspace, VIBE_EDITOR_CURRENT_WORKSPACE: currentWorkspace, ...(currentProvider ? { VIBE_EDITOR_CURRENT_PROVIDER: currentProvider } : {}) } }
    : { transport: "stdio", name: "vibe-editor", command: process.execPath, args: [compiled], env: { VIBE_EDITOR_ROOT_WORKSPACE: rootWorkspace, VIBE_EDITOR_CURRENT_WORKSPACE: currentWorkspace, ...(currentProvider ? { VIBE_EDITOR_CURRENT_PROVIDER: currentProvider } : {}) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
