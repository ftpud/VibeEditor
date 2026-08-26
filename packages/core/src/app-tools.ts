import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import type { AiConfiguration, AiProvider } from "@remote-ide/acp";
import { WorkspaceTaskStore, type WorkspaceTask } from "./tasks.js";
import { createAcpRegistry, type AcpRegistry } from "./ai/index.js";
import { summarizeAiSessions } from "./ai/summary.js";
import { AppEventBridge } from "./app-events.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const appToolDefinitions = [
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
    description: "Create an isolated Vibe Editor task and start an AI agent in it.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        branch: { type: "string", description: "Git branch name for the task. Omit to generate one." },
        prompt: { type: "string", description: "Work to give the new task's agent." },
        provider: { type: "string", description: "AI provider id, for example codex or copilot." },
        model: { type: "string", description: "Model id supported by the selected provider." }
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
  }
] as const;

export class AppToolService {
  constructor(private readonly tasks: WorkspaceTaskStore, private readonly acp: AcpRegistry, private readonly onTasksChanged: () => Promise<void> = async () => undefined) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
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
      const task = branch ? await this.tasks.create(branch, false, false, false) : await this.tasks.createRandom(false);
      await this.onTasksChanged();
      try {
        const configuration: AiConfiguration = { model };
        const session = await this.acp.get(provider).send(this.tasks.taskPath(task.id), { prompt, configuration });
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
      await this.tasks.delete(task.id);
      await this.onTasksChanged();
      return { deleted: task };
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
    return { status: summary.status, providers: Object.fromEntries(this.acp.list().map((provider, index) => [provider.id, sessions[index]!.status])) };
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

async function main() {
  const rootWorkspace = process.env.VIBE_EDITOR_ROOT_WORKSPACE;
  if (!rootWorkspace) throw new Error("VIBE_EDITOR_ROOT_WORKSPACE is required");
  const events = new AppEventBridge(rootWorkspace);
  const service = new AppToolService(new WorkspaceTaskStore(rootWorkspace), createAcpRegistry((workspace) => { void events.emit({ type: "ai.changed", workspace }); }), () => events.emit({ type: "tasks.changed" }));
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
        const value = await service.call(requiredString(params, "name"), (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
