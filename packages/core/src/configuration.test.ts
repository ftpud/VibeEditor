import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentsStore } from "./agents.js";
import { SkillsStore } from "./skills.js";
import { UsefulFilesStore } from "./useful-files.js";
import { HarnessStore } from "./harnesses.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { ConfigurationService } from "./configuration.js";
import { ensureSelfConfiguration } from "./self-configuration.js";
import { AppToolService, appToolDefinitions } from "./app-tools.js";
import type { AcpRegistry } from "./ai/acp.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-configuration-")); temporary.push(root);
  const workspace = path.join(root, "project"); const taskWorkspace = path.join(root, "checkout"); const state = path.join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(taskWorkspace)]);
  const stores = { agents: new AgentsStore(workspace, state), skills: new SkillsStore(state), useful: new UsefulFilesStore(workspace, state), workflows: new HarnessStore(workspace, state), tasks: new WorkspaceTaskStore(workspace, state) };
  const acp = { list: () => [], get: vi.fn() } as unknown as AcpRegistry;
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
    await service.write("useful/local/notes.md", "Project notes", null);
    await service.write("useful/global/reference.md", "Shared reference", null);
    expect(await readFile(path.join(taskWorkspace, ".agents/reviewer.md"), "utf8")).toBe("Workspace agent");
    expect(await readFile(path.join(taskWorkspace, ".agents/skills/testing/SKILL.md"), "utf8")).toBe("Testing instructions");
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
});
