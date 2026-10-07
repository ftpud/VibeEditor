import crypto from "node:crypto";
import type { AcpRegistry } from "./ai/acp.js";
import type { AgentFileScope, HarnessDefinition, SkillPolicy } from "@remote-ide/protocol";
import { AgentsStore } from "./agents.js";
import { SkillsStore } from "./skills.js";
import { UsefulFilesStore } from "./useful-files.js";
import { HarnessStore, isHarnessDefinition } from "./harnesses.js";
import { validateHarness } from "./harness-graph.js";
import type { WorkspaceTaskStore } from "./tasks.js";
import { CoreError } from "./errors.js";

export type ConfigurationDocument = { resource: string; exists: boolean; content: string; revision: string | null };
type Resource = { kind: "agents"; scope: AgentFileScope; name: string } | { kind: "skills"; scope: "global" | "local"; name: string } | { kind: "useful"; scope: "global" | "local"; name: string } | { kind: "policy" } | { kind: "workflows"; id: string } | { kind: "tasks"; id: string };
const queues = new Map<string, Promise<unknown>>();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const starterWorkflow = { name: "New Workflow", blocks: [
  { id: "start", type: "start_button", label: "Start", prompt: "Start this workflow.", position: { x: 40, y: 80 } },
  { id: "instructions", type: "markdown", label: "Instructions", prompt: "{{input}}", position: { x: 280, y: 80 } }
], edges: [{ id: "start-instructions", from: "start", to: "instructions", type: "follow" }] };

function parseResource(resource: string): Resource {
  if (typeof resource !== "string" || resource.length > 300 || resource.includes("\0") || resource.includes("\\") || resource.split("/").some((part) => !part || part === "." || part === "..")) throw new CoreError("INVALID_REQUEST", "Invalid configuration resource");
  if (resource === "skills/policy.json") return { kind: "policy" };
  const parts = resource.split("/");
  const [kind, scope, name] = parts;
  if (kind === "agents" && parts.length === 3 && ["global", "local", "workspace"].includes(scope!) && name!.length <= 180 && /\.md$/i.test(name!)) return { kind, scope: scope as AgentFileScope, name: name! };
  if (kind === "skills" && parts.length === 4 && ["global", "local"].includes(scope!) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name!) && parts[3] === "SKILL.md") return { kind, scope: scope as "global" | "local", name: name! };
  if (kind === "useful" && parts.length === 3 && ["global", "local"].includes(scope!) && name!.length <= 180) return { kind, scope: scope as "global" | "local", name: name! };
  if ((kind === "workflows" || kind === "tasks") && parts.length === 2 && /^[a-zA-Z0-9_-]+\.json$/.test(scope!)) return { kind, id: scope!.slice(0, -5) };
  throw new CoreError("INVALID_REQUEST", "Unknown configuration resource. Use configuration_list for supported names and formats.");
}

/** A logical document interface, never an interface to private registry files. */
export class ConfigurationService {
  constructor(private readonly rootWorkspace: string, private readonly workspace: string, private readonly stores: { agents: AgentsStore; skills: SkillsStore; useful: UsefulFilesStore; workflows: HarnessStore; tasks: WorkspaceTaskStore }, private readonly acp: AcpRegistry, private readonly changed: (resource: string, global: boolean) => Promise<void> = async () => undefined) {}

  async list(includeModels = false) {
    const [agents, skills, useful, workflows, registry] = await Promise.all([this.stores.agents.list(this.workspace), this.stores.skills.list(this.workspace), this.stores.useful.list(), this.stores.workflows.list(), this.stores.tasks.list()]);
    const resources = [
      ...agents.map((file) => ({ resource: `agents/${file.scope}/${file.name}`, title: file.agent.name, description: file.agent.description })),
      ...skills.skills.map((file) => ({ resource: `skills/${file.id}/SKILL.md`, title: file.title, description: file.description })),
      ...useful.map((file) => ({ resource: `useful/${file.scope}/${file.name}`, title: file.name })),
      ...workflows.map((file) => ({ resource: `workflows/${file.id}.json`, title: file.name })),
      ...registry.tasks.map((task) => ({ resource: `tasks/${task.id}.json`, title: task.name, description: task.branch })),
      { resource: "skills/policy.json", title: "Project skill policy" }
    ];
    const providers = await Promise.all(this.acp.list().map(async (provider) => ({ ...provider, ...(includeModels ? { models: await this.acp.get(provider.id).models() } : {}) })));
    return { rootWorkspace: this.rootWorkspace, workspace: this.workspace, resources, providers, formats: {
      agents: "agents/{global|local|workspace}/{file.md}: Markdown with name, description and optional mcpServers frontmatter. Global/local are Core state; workspace is the invoking checkout's .agents directory.",
      skills: "skills/{global|local}/{name}/SKILL.md: Markdown instructions. Local is the invoking checkout's .agents/skills directory.",
      useful: "useful/{global|local}/{filename}: arbitrary text. Local belongs to the root project, global is shared across projects on Core.",
      policy: "skills/policy.json: JSON {allowed: [global/name or local/name], defaults: [...], agents?: {skillId: [{scope, name}, null]}}. Defaults must be allowed; null means no agent; absent assignment means any agent.",
      workflows: "workflows/{id}.json: full JSON workflow definition; read workflows/new.json for a starter. Core owns id, version and timestamps. Saving never starts a run. Workflow graph validation is returned separately so drafts can be edited.",
      tasks: "tasks/{id}.json: JSON {name, status: active|finished, archived: boolean}. Existing task tools create/delete worktrees, start sessions and merge. Branches, paths and runtime state are not editable documents."
    } };
  }

  async read(resource: string): Promise<ConfigurationDocument> {
    const target = parseResource(resource);
    let content = ""; let exists = false;
    if (target.kind === "agents") {
      exists = (await this.stores.agents.list(this.workspace)).some((file) => file.scope === target.scope && file.name === target.name);
      if (exists) content = await this.stores.agents.read(target.scope, target.name, this.workspace);
    } else if (target.kind === "skills") {
      exists = (await this.stores.skills.list(this.workspace)).skills.some((file) => file.id === `${target.scope}/${target.name}`);
      if (exists) content = await this.stores.skills.read(`${target.scope}/${target.name}`, this.workspace);
    } else if (target.kind === "useful") {
      exists = (await this.stores.useful.list()).some((file) => file.scope === target.scope && file.name === target.name);
      if (exists) content = await this.stores.useful.read(target.scope, target.name);
    } else if (target.kind === "policy") {
      exists = true; content = json((await this.stores.skills.list(this.workspace)).policy);
    } else if (target.kind === "workflows") {
      if (target.id === "new") content = json(starterWorkflow);
      else { exists = true; content = json(await this.stores.workflows.read(target.id)); }
    } else {
      const task = (await this.stores.tasks.list()).tasks.find((item) => item.id === target.id);
      if (!task) throw new CoreError("FILE_NOT_FOUND", "Task does not exist; use task_create to create its worktree");
      exists = true; content = json({ name: task.name, status: task.status, archived: task.archived ?? false });
    }
    return { resource, exists, content, revision: exists ? crypto.createHash("sha256").update(content).digest("hex") : null };
  }

  async write(resource: string, content: string, expectedRevision: string | null) {
    const target = parseResource(resource);
    if (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new CoreError("FILE_TOO_LARGE", "Configuration document must be text under 2 MB");
    if (expectedRevision !== null && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new CoreError("INVALID_REQUEST", "expected_revision must be the read revision, or null for creation");
    const global = "scope" in target && target.scope === "global";
    const queueKey = `${global ? "global" : this.rootWorkspace}\0${target.kind === "tasks" ? "tasks" : resource}`;
    const operation = (queues.get(queueKey) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await this.read(resource);
      if (previous.revision !== expectedRevision) throw new CoreError("CONFLICT", "Configuration changed since it was read. Reload and reconcile before writing.");
      let writtenResource = resource;
      if (target.kind === "agents") {
        if (!previous.exists) {
          if (target.scope === "workspace") await this.stores.agents.createWorkspace(target.name, this.workspace);
          else await this.stores.agents.create(target.scope, target.name, this.workspace);
        }
        await this.stores.agents.write(target.scope, target.name, content, this.workspace);
      } else if (target.kind === "skills") await this.stores.skills.write(`${target.scope}/${target.name}`, this.workspace, content);
      else if (target.kind === "useful") {
        if (!previous.exists) await this.stores.useful.create(target.scope, target.name);
        await this.stores.useful.write(target.scope, target.name, content);
      } else if (target.kind === "policy") await this.stores.skills.writePolicy(this.workspace, this.parseJson(content) as SkillPolicy);
      else if (target.kind === "workflows") {
        const value = this.parseJson(content);
        const now = new Date().toISOString();
        const current = target.id === "new" ? undefined : await this.stores.workflows.read(target.id);
        const candidate = { ...value, id: current?.id ?? crypto.randomUUID(), version: current?.version ?? 1, createdAt: current?.createdAt ?? now, updatedAt: now };
        if (!isHarnessDefinition(candidate)) throw new CoreError("INVALID_REQUEST", "Invalid workflow definition; read a workflow or workflows/new.json for its format");
        if (current && value.id !== undefined && value.id !== current.id) throw new CoreError("INVALID_REQUEST", "Workflow IDs cannot be changed");
        if (current && value.version !== current.version) throw new CoreError("CONFLICT", "Workflow version changed; reload before saving");
        const saved = current ? await this.stores.workflows.update(candidate) : await this.stores.workflows.createDefinition(candidate);
        writtenResource = `workflows/${saved.id}.json`;
      } else {
        const value = this.parseJson(content);
        if (Object.keys(value).some((key) => !["name", "status", "archived"].includes(key)) || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 200 || value.name.includes("\0") || !["active", "finished"].includes(value.status as string) || typeof value.archived !== "boolean") throw new CoreError("INVALID_REQUEST", "Task document must contain only name, status (active/finished) and archived (boolean)");
        await this.stores.tasks.updateMetadata(target.id, { name: value.name, status: value.status as "active" | "finished", archived: value.archived });
      }
      await this.changed(writtenResource, global);
      const document = await this.read(writtenResource);
      return { ...document, ...(target.kind === "workflows" ? { validation: validateHarness(JSON.parse(document.content) as HarnessDefinition) } : {}) };
    });
    queues.set(queueKey, operation);
    try { return await operation; } finally { if (queues.get(queueKey) === operation) queues.delete(queueKey); }
  }

  private parseJson(content: string): Record<string, unknown> {
    try { const value: unknown = JSON.parse(content); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object"); return value as Record<string, unknown>; }
    catch (error) { throw new CoreError("INVALID_REQUEST", `Invalid JSON configuration: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
