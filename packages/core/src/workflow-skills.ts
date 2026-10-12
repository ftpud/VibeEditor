import crypto from "node:crypto";
import type { AiSession, HarnessBlock, HarnessDefinition } from "@remote-ide/protocol";
import { resolveSkillIds } from "@remote-ide/protocol";
import type { HarnessRunner } from "./harness-runner.js";
import { CoreError } from "./errors.js";
import type { SkillsStore } from "./skills.js";

type Runtime = Parameters<Parameters<HarnessRunner["start"]>[2]>[2];

/** Refresh catalogue metadata without putting linked instructions into the workflow. */
export async function prepareWorkflowSkills(definition: HarnessDefinition, skills: SkillsStore, workspace: string): Promise<HarnessDefinition> {
  if (!definition.blocks.some((block) => block.type === "skill" && block.skillId)) return definition;
  const catalog = await skills.list(workspace);
  return { ...definition, blocks: definition.blocks.map((block) => {
    if (block.type !== "skill" || !block.skillId) return block;
    const [id] = resolveSkillIds(catalog, [block.skillId]);
    const skill = catalog.skills.find((item) => item.id === id);
    if (!skill) throw new CoreError("FILE_NOT_FOUND", `Skill '${block.skillId}' is missing from this workspace`);
    return { ...block, skillId: skill.id, description: skill.description ?? skill.title, prompt: "" };
  }) };
}

export async function executeWorkflowSkill(block: HarnessBlock, skills: SkillsStore, workspace: string, runtime: Runtime): Promise<AiSession> {
  runtime.assertActive();
  const loaded = await skills.loadForWorkflow(workspace, block.skillId!, runtime.skillAgent);
  runtime.assertActive();
  return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(loaded), timestamp: new Date().toISOString() }] } as AiSession;
}

/** Enable attached references in the provider's native skill catalogue too. */
export async function workflowSessionSkillIds(definition: HarnessDefinition | undefined, block: HarnessBlock, skills: SkillsStore, workspace: string): Promise<string[] | undefined> {
  if (!definition || !["ai", "chatbox"].includes(block.type)) return undefined;
  const targets = definition.edges.filter((edge) => edge.from === block.id && (edge.type === "use" || block.type === "chatbox")).map((edge) => definition.blocks.find((item) => item.id === edge.to));
  const ids = targets.filter((target) => target?.type === "skill" && target.skillId).map((target) => target!.skillId!);
  if (!ids.length) return undefined;
  const defaults = await skills.available(workspace, await skills.defaults(workspace), block.agent);
  return [...new Set([...defaults.map((skill) => skill.id), ...ids])];
}
