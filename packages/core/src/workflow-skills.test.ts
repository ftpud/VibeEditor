import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";
import { WorkspaceTaskStore } from "./tasks.js";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner } from "./harness-runner.js";
import { SkillsStore } from "./skills.js";
import { startWorkflow } from "./server.js";
import { prepareWorkflowSkills, executeWorkflowSkill, workflowSessionSkillIds } from "./workflow-skills.js";

const roots: string[] = [];
const runners: { runner: HarnessRunner; store: HarnessStore }[] = [];
afterEach(async () => {
  for (const { runner, store } of runners.splice(0)) await vi.waitFor(async () => expect((await store.runs()).some((run) => runner.isActive(run.id))).toBe(false), { timeout: 5000 });
  vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(type: "ai" | "chatbox" = "ai") {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-skill-picker-")); roots.push(root);
  const workspace = path.join(root, "project"); await mkdir(workspace);
  const skills = new SkillsStore(path.join(root, "state"), workspace);
  await skills.write("workspace/review", workspace, "---\nname: Reviewer\ndescription: Review code changes\n---\n\nRead examples.txt. Keep {{example}} literal.\n");
  await writeFile(path.join(workspace, ".agents/skills/review/examples.txt"), "Examples");
  const store = new HarnessStore(workspace, path.join(root, "state"));
  const runner = new HarnessRunner(store, () => {}, 1); runners.push({ runner, store });
  const created = await store.create("Review");
  const definition = await store.update({ ...created, blocks: [
    { id: "agent", type, label: "Agent", prompt: "Review", position: { x: 0, y: 0 } },
    { id: "skill", type: "skill", label: "Reviewer", skillId: "workspace/review", description: "Old description", prompt: "", position: { x: 220, y: 0 } }
  ], edges: [{ id: "use", from: "agent", to: "skill", type: "use" }] });
  return { skills, workspace, runner, store, definition, state: path.join(root, "state") };
}

it.each(["ai", "chatbox"] as const)("loads linked skills on demand for %s with current content and supporting-file paths", async (type) => {
  const { skills, workspace, runner, definition, store } = await setup(type);
  const preset = type === "chatbox" ? { scope: "workspace" as const, name: "reviewer.md" } : null;
  if (preset) {
    definition.blocks[0]!.agent = preset;
    await store.update(definition);
    await skills.writePolicy(workspace, { allowed: ["workspace/review"], defaults: [], agents: { "workspace/review": [preset] } });
  }
  const load = vi.spyOn(skills, "loadForWorkflow");
  const dispatch: Parameters<HarnessRunner["start"]>[2] = async (block, prompt, runtime) => {
    if (block.type === "skill") return executeWorkflowSkill(block, skills, workspace, runtime);
    expect(prompt).toContain("Review code changes");
    expect(prompt).not.toContain("Read examples.txt");
    expect(load).not.toHaveBeenCalled();
    // Linked blocks read saved changes when used, rather than copying instructions.
    await skills.write("workspace/review", workspace, "---\nname: Reviewer\ndescription: Review code changes\n---\n\nUpdated instructions. Keep {{example}} literal.\n");
    const loaded = await runner.flowTool(runtime.runId, block.id, "workflow_use_block", { block_id: "skill" }) as { skill: { content: string; baseDirectory: string; id: string } };
    expect(loaded.skill).toMatchObject({ id: "workspace/review", baseDirectory: path.join(workspace, ".agents/skills/review") });
    expect(loaded.skill.content).toContain("Updated instructions. Keep {{example}} literal.");
    return { id: "session", status: "idle", messages: [{ id: "reply", role: "assistant", text: "Reviewed", timestamp: "now" }] } as AiSession;
  };
  const run = await runner.start(definition.id, "Review", dispatch, "codex", undefined, undefined, undefined, undefined, workspace, (definition) => prepareWorkflowSkills(definition, skills, workspace));
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  expect((await runner.readRun(run.id))!.definition!.blocks[1]).toMatchObject({ skillId: "workspace/review", prompt: "", description: "Review code changes" });
  expect((await store.read(definition.id)).blocks[1]).toMatchObject({ skillId: "workspace/review", prompt: "" });
  expect(load).toHaveBeenCalledWith(workspace, "workspace/review", preset);
});

it("checks agent access and live revocation for linked skills", async () => {
  const { skills, workspace, definition } = await setup();
  const reviewer = { scope: "workspace" as const, name: "reviewer.md" };
  await skills.writePolicy(workspace, { allowed: ["workspace/review"], defaults: [], agents: { "workspace/review": [reviewer] } });
  const block = definition.blocks[1]!;
  const runtime = { assertActive: () => {}, skillAgent: reviewer } as Parameters<typeof executeWorkflowSkill>[3];
  const loaded = await executeWorkflowSkill(block, skills, workspace, runtime);
  expect(JSON.parse(loaded.messages[0]!.text).content).toContain("Read examples.txt");
  await expect(executeWorkflowSkill(block, skills, workspace, { ...runtime, skillAgent: null })).rejects.toThrow("not allowed");
  await skills.writePolicy(workspace, { allowed: [], defaults: [] });
  await expect(executeWorkflowSkill(block, skills, workspace, runtime)).rejects.toThrow("not allowed");
});

it("reports missing linked skills before starting a workflow", async () => {
  const { skills, workspace, definition } = await setup();
  await skills.delete("workspace/review", workspace);
  await expect(prepareWorkflowSkills(definition, skills, workspace)).rejects.toThrow("missing from this workspace");
});

it("loads a linked skill through Core’s workflow dispatch", async () => {
  const { workspace, runner, store, definition, state } = await setup();
  vi.stubEnv("REMOTE_IDE_STATE_DIR", state);
  const direct = await store.update({ ...definition, blocks: [definition.blocks[1]!], edges: [] });
  const run = await startWorkflow({ harnessId: direct.id, input: "Load skill", provider: "codex" }, { tasks: new WorkspaceTaskStore(workspace), harnessRunner: runner, rootWorkspace: workspace, workspacePath: workspace } as Parameters<typeof startWorkflow>[1]);
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  const loaded = JSON.parse((await runner.readRun(run.id))!.blocks[0]!.output!);
  expect(loaded).toMatchObject({ id: "workspace/review", baseDirectory: path.join(workspace, ".agents/skills/review") });
  expect(loaded.content).toContain("Keep {{example}} literal.");
});

it("enables attached skills in the provider catalogue while retaining allowed defaults", async () => {
  const { skills, workspace, definition } = await setup();
  await skills.write("local/default", workspace, "---\nname: Default\ndescription: Default skill\n---\nDefault instructions");
  await skills.writePolicy(workspace, { allowed: ["local/default", "workspace/review"], defaults: ["local/default"] });
  expect(await workflowSessionSkillIds(definition, definition.blocks[0]!, skills, workspace)).toEqual(["local/default", "workspace/review"]);
  const withoutLinks = { ...definition, edges: [] };
  expect(await workflowSessionSkillIds(withoutLinks, definition.blocks[0]!, skills, workspace)).toBeUndefined();
});

it("passes linked skills to a workflow agent’s native provider catalogue", async () => {
  const { workspace, runner, definition, state } = await setup();
  vi.stubEnv("REMOTE_IDE_STATE_DIR", state);
  const completed = { id: "session", model: "test", reasoning: "", status: "idle", messages: [{ id: "reply", role: "assistant", text: "Done", timestamp: "now" }] } as AiSession;
  const provider = { descriptor: { id: "test", options: [] }, models: vi.fn(async () => []), get: vi.fn(async () => completed), startFreshSession: vi.fn(async (_workspace: string, _request: unknown) => completed) };
  const context = { tasks: new WorkspaceTaskStore(workspace), harnessRunner: runner, rootWorkspace: workspace, workspacePath: workspace, bridgeWorkspace: workspace, acp: { get: () => provider }, agents: { list: async () => [] }, aiTimers: { next: async () => undefined } } as unknown as Parameters<typeof startWorkflow>[1];
  const run = await startWorkflow({ harnessId: definition.id, input: "Review", provider: "test" }, context);
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  expect(provider.startFreshSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ skillIds: ["workspace/review"] }));
});
