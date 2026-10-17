import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentsStore } from "./agents.js";
import { SkillsStore } from "./skills.js";
import { UsefulFilesStore } from "./useful-files.js";
import { HarnessStore } from "./harnesses.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { ConfigurationService } from "./configuration.js";
import { CONFIGURATION_SKILL, ensureSelfConfiguration } from "./self-configuration.js";
import { CONFIGURATION_REFERENCES } from "./self-configuration-reference.js";
import { validateHarness } from "./harness-graph.js";
import { isHarnessDefinition } from "./harnesses.js";
import { AppToolService, appToolDefinitions, flowToolDefinitions } from "./app-tools.js";
import type { AcpRegistry } from "./ai/acp.js";
import { TriggerService } from "./triggers.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-configuration-")); temporary.push(root);
  const workspace = path.join(root, "project"); const taskWorkspace = path.join(root, "checkout"); const state = path.join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(taskWorkspace)]);
  const stores = { agents: new AgentsStore(workspace, state), skills: new SkillsStore(state, workspace), useful: new UsefulFilesStore(workspace, state), workflows: new HarnessStore(workspace, state), tasks: new WorkspaceTaskStore(workspace, state) };
  const acp = { list: () => [], available: async () => [], get: vi.fn() } as unknown as AcpRegistry;
  const changed = vi.fn(async () => undefined);
  const service = new ConfigurationService(workspace, taskWorkspace, stores, acp, changed);
  return { root, workspace, taskWorkspace, state, stores, acp, changed, service };
}

describe("logical configuration documents", () => {
  it("creates scoped documents through MCP, reads back revisions and rejects stale edits", async () => {
    const { stores, acp, taskWorkspace, workspace, service, changed } = await fixture();
    const mcp = new AppToolService(stores.tasks, acp, taskWorkspace, undefined, undefined, undefined, stores.agents, workspace, undefined, undefined, undefined, service);
    const resource = "agents/global/reviewer.md";
    expect(await mcp.call("configuration_read", { resource })).toMatchObject({ exists: false, revision: null });
    const first = await mcp.call("configuration_write", { resource, content: "---\nname: Reviewer\nmcpServers: [vibe-editor]\n---\nReview changes.", expected_revision: null }) as { revision: string };
    expect((await service.list()).resources.some((item) => item.resource === resource)).toBe(true);
    expect(changed).toHaveBeenCalledWith(resource, true);
    const second = await service.write(resource, "Updated reviewer", first.revision);
    await expect(service.write(resource, "Stale overwrite", first.revision)).rejects.toThrow("Reload");
    expect((await service.read(resource)).content).toBe("Updated reviewer");
    expect(second.revision).not.toBe(first.revision);
    await expect(mcp.call("configuration_write", { resource, content: "Missing revision" })).rejects.toThrow("expected_revision");
    expect(appToolDefinitions.filter((tool) => tool.name.startsWith("configuration_")).map((tool) => tool.name)).toEqual(["configuration_list", "configuration_read", "configuration_write"]);
  });

  it("keeps local state rooted in the project while workspace agents and skills target the invoking checkout", async () => {
    const { service, stores, taskWorkspace, workspace } = await fixture();
    await service.write("agents/local/developer.md", "Project-local agent", null);
    await service.write("agents/workspace/reviewer.md", "Workspace agent", null);
    await service.write("skills/local/testing/SKILL.md", "Testing instructions", null);
    await service.write("skills/workspace/testing/SKILL.md", "Checkout instructions", null);
    await service.write("useful/local/notes.md", "Project notes", null);
    await service.write("useful/global/reference.md", "Shared reference", null);
    expect(await readFile(path.join(taskWorkspace, ".agents/reviewer.md"), "utf8")).toBe("Workspace agent");
    expect(await readFile(path.join(taskWorkspace, ".agents/skills/testing/SKILL.md"), "utf8")).toBe("Checkout instructions");
    expect(await stores.skills.read("local/testing", workspace)).toBe("Testing instructions");
    expect((await stores.skills.list(workspace)).skills.map((file) => file.id)).toEqual(["local/testing"]);
    const fromRoot = new ConfigurationService(workspace, workspace, stores, { list: () => [], available: async () => [] } as unknown as AcpRegistry);
    const local = await fromRoot.read("skills/local/testing/SKILL.md");
    await fromRoot.write(local.resource, "Updated shared instructions", local.revision);
    expect((await service.read(local.resource)).content).toBe("Updated shared instructions");
    expect((await service.list()).formats.skills).toContain("all tasks");
    expect((await stores.agents.list(workspace)).some((agent) => agent.scope === "local" && agent.name === "developer.md")).toBe(true);
    expect((await stores.agents.list(workspace)).some((agent) => agent.scope === "workspace")).toBe(false);
    expect(await stores.useful.read("local", "notes.md")).toBe("Project notes");
    const policy = await service.read("skills/policy.json");
    await service.write(policy.resource, JSON.stringify({ allowed: ["local/testing"], defaults: ["local/testing"], agents: { "local/testing": [null] } }), policy.revision);
    expect(await stores.skills.defaults(taskWorkspace)).toEqual(["local/testing"]);
  });

  it("creates and updates workflow definitions without creating runs, validating before creation", async () => {
    const { service, stores } = await fixture();
    const template = await service.read("workflows/new.json");
    await expect(service.write(template.resource, JSON.stringify({ name: "Invalid", blocks: [{}], edges: [] }), null)).rejects.toThrow("Invalid workflow");
    expect(await stores.workflows.list()).toHaveLength(0);
    const created = await service.write(template.resource, template.content, null);
    expect(created.resource).toMatch(/^workflows\/.+\.json$/);
    expect(created.validation?.valid).toBe(true);
    const value = JSON.parse(created.content); value.name = "Updated workflow";
    const saved = await service.write(created.resource, JSON.stringify(value), created.revision);
    expect(JSON.parse(saved.content)).toMatchObject({ name: "Updated workflow", version: 2 });
    expect(await stores.workflows.runs()).toEqual([]);
    await expect(service.write(created.resource, JSON.stringify(value), created.revision)).rejects.toThrow("Reload");
  });

  it("limits task documents to metadata and preserves branch/path ownership", async () => {
    const { service, stores } = await fixture();
    const task = { id: "task-1", name: "Original", branch: "feature/x", baseBranch: "main", status: "active" as const, archived: false };
    vi.spyOn(stores.tasks, "list").mockResolvedValue({ tasks: [task] });
    const update = vi.spyOn(stores.tasks, "updateMetadata").mockImplementation(async (_id, value) => { Object.assign(task, value); return task; });
    const doc = await service.read("tasks/task-1.json");
    await expect(service.write(doc.resource, JSON.stringify({ name: "Changed", status: "finished", archived: true, branch: "other" }), doc.revision)).rejects.toThrow("only name");
    expect(update).not.toHaveBeenCalled();
    await service.write(doc.resource, JSON.stringify({ name: "Changed", status: "finished", archived: true }), doc.revision);
    expect(update).toHaveBeenCalledWith("task-1", { name: "Changed", status: "finished", archived: true });
    expect(task.branch).toBe("feature/x");
  });

  it("serializes competing edits to the same global document across projects", async () => {
    const { service, stores, acp, taskWorkspace } = await fixture();
    const initial = await service.write("useful/global/shared.md", "Original", null);
    const other = new ConfigurationService("/other-project", taskWorkspace, stores, acp);
    const results = await Promise.allSettled([service.write(initial.resource, "First", initial.revision), other.write(initial.resource, "Second", initial.revision)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects arbitrary paths, registry access, malformed JSON and illegal scope writes", async () => {
    const { service } = await fixture();
    for (const resource of ["/etc/passwd", "agents/global/../secret.md", "tasks/../tasks.json", "skills/global/name/other.md", "useful/workspace/notes.md", "workflows/index.json/extra"]) await expect(service.read(resource)).rejects.toThrow();
    const policy = await service.read("skills/policy.json");
    await expect(service.write(policy.resource, "{broken", policy.revision)).rejects.toThrow("Invalid JSON");
    await expect(service.write(policy.resource, JSON.stringify({ allowed: [], defaults: ["local/not-allowed"] }), policy.revision)).rejects.toThrow("defaults must be allowed");
  });
});

describe("global configuration defaults", () => {
  it("upgrades the latest shipped skill and installs readable linked references", async () => {
    const { state, stores, workspace, service } = await fixture();
    const directory = path.join(state, "skills/global/vibe-self-configuration");
    await mkdir(directory, { recursive: true });
    const previous = CONFIGURATION_SKILL.split("\n\n## Detailed reference")[0]! + "\n";
    await writeFile(path.join(directory, "SKILL.md"), previous);
    await ensureSelfConfiguration(state);
    expect(await stores.skills.read("global/vibe-self-configuration", workspace)).toBe(CONFIGURATION_SKILL);
    for (const [name, content] of Object.entries(CONFIGURATION_REFERENCES)) {
      expect(CONFIGURATION_SKILL).toContain(`references/${name}`);
      expect(await readFile(path.join(directory, "references", name), "utf8")).toBe(content);
    }
    expect((await service.read("skills/global/vibe-self-configuration/SKILL.md")).baseDirectory).toBe(directory);
    const custom = path.join(directory, "references/blocks.md");
    await writeFile(custom, "Custom block guidance");
    await ensureSelfConfiguration(state);
    expect(await readFile(custom, "utf8")).toBe("Custom block guidance");
  });

  it("documents all protocol block types and exact app and flow command schemas", async () => {
    const protocol = await readFile(new URL("../../protocol/src/index.ts", import.meta.url), "utf8");
    const union = /export type HarnessBlock = \{ id: string; type: ([^;]+);/.exec(protocol)![1]!;
    for (const match of union.matchAll(/"([a-z_]+)"/g)) {
      expect(CONFIGURATION_REFERENCES["blocks.md"]).toContain(`### ${match[1]} —`);
    }
    for (const tool of [...appToolDefinitions, ...flowToolDefinitions]) {
      expect(CONFIGURATION_REFERENCES["commands.md"]).toContain(`## ${tool.name}\n`);
      expect(CONFIGURATION_REFERENCES["commands.md"]).toContain(JSON.stringify(tool.inputSchema, null, 2));
    }
    const source = CONFIGURATION_REFERENCES["blocks.md"]!;
    const example = JSON.parse(/~~~json\n([\s\S]*?)\n~~~/.exec(source)![1]!);
    const definition = { ...example, id: "example", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    expect(isHarnessDefinition(definition)).toBe(true);
    expect(validateHarness(definition)).toMatchObject({ valid: true, issues: [] });
    const { service } = await fixture();
    expect((await service.write("workflows/new.json", JSON.stringify(example), null)).validation?.valid).toBe(true);
  });

  it("refreshes an untouched earlier reference but keeps a user-edited one", async () => {
    const { state } = await fixture();
    const directory = path.join(state, "skills/global/vibe-self-configuration/references");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "configuration.md"), "My own notes");
    await ensureSelfConfiguration(state);
    expect(await readFile(path.join(directory, "configuration.md"), "utf8")).toBe("My own notes");
  });

  it("upgrades the unedited shipped skill when project-local scopes change", async () => {
    const { state, stores, workspace } = await fixture();
    const previous = CONFIGURATION_SKILL.split("\n\n## Detailed reference")[0]! + "\n";
    const legacy = previous
      .replace("local agents, local skills, skill policy,\nuseful files and workflows belong to its root project and are shared by every task, while\nworkspace agents and workspace skills belong to the invoking checkout.", "local agents, useful files\nand workflows belong to its root project, while workspace agents, local skills\nand skill policy belong to the invoking checkout.")
      .replace("Use skills/local/{name}/SKILL.md for skills shared by all tasks in this project,\nskills/workspace/{name}/SKILL.md for checkout files and skills/global/{name}/SKILL.md\nfor host-wide skills. All three scopes can be created and edited through the tools.\n\n", "");
    const directory = path.join(state, "skills/global/vibe-self-configuration");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), legacy);
    await ensureSelfConfiguration(state);
    expect(await stores.skills.read("global/vibe-self-configuration", workspace)).toBe(CONFIGURATION_SKILL);
  });

  it("installs the agent and skill for every project and retains custom versions on startup", async () => {
    const { stores, state, workspace, taskWorkspace } = await fixture();
    await ensureSelfConfiguration(state);
    const global = (await stores.agents.list(workspace)).find((agent) => agent.name === "vibe-configurator.md")!;
    expect(global).toMatchObject({ scope: "global", agent: { name: "Vibe Configurator", mcpServers: ["vibe-editor"] } });
    expect((await new AgentsStore(taskWorkspace, state).list(taskWorkspace)).some((agent) => agent.name === global.name)).toBe(true);
    expect((await stores.skills.list(workspace)).skills.some((skill) => skill.id === "global/vibe-self-configuration")).toBe(true);
    await stores.agents.write("global", global.name, "Custom configuration agent", workspace);
    await stores.skills.write("global/vibe-self-configuration", workspace, "Custom configuration skill");
    await ensureSelfConfiguration(state);
    expect(await stores.agents.read("global", global.name, workspace)).toBe("Custom configuration agent");
    expect(await stores.skills.read("global/vibe-self-configuration", workspace)).toBe("Custom configuration skill");
  });

  it("creates, lists and edits persistent triggers through the configuration interface", async () => {
    const { root, workspace, stores, acp, taskWorkspace } = await fixture();
    const triggers = new TriggerService(workspace, async () => ({}), vi.fn(), path.join(root, "trigger-state"));
    await triggers.start();
    try {
      const service = new ConfigurationService(workspace, taskWorkspace, { ...stores, triggers: { service: triggers, rootId: "root" } }, { ...acp, get: vi.fn(() => ({})) } as unknown as AcpRegistry);
      const starter = JSON.parse((await service.read("triggers/new.json")).content);
      expect(starter).toMatchObject({ enabled: false, source: { type: "file" } });
      const created = await service.write("triggers/new.json", JSON.stringify({ ...starter, name: "Build log", source: { type: "file", path: "logs/build.log", events: ["changed"] } }), null);
      const listed = triggers.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ name: "Build log", enabled: false, source: { path: path.join(workspace, "logs/build.log") } });
      expect(created.resource).toBe(`triggers/${listed[0]!.id}.json`);
      expect((await service.list()).resources.some((item) => item.resource === created.resource)).toBe(true);
      const edited = await service.write(created.resource, JSON.stringify({ ...JSON.parse(created.content), name: "Renamed", enabled: true }), created.revision);
      expect(JSON.parse(edited.content)).toMatchObject({ name: "Renamed", enabled: true });
      expect(triggers.list()[0]).toMatchObject({ id: listed[0]!.id, name: "Renamed", enabled: true });
      await expect(service.write("triggers/new.json", JSON.stringify({ ...starter, bogus: true }), null)).rejects.toThrow("Trigger document");
    } finally { await triggers.close(); }
  });
});
