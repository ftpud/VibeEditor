import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolveSkillIds, skillAllowedForAgent } from "@remote-ide/protocol";
import type { AiAgentPreset, SkillCatalog, SkillFile, SkillPolicy, SkillScope } from "@remote-ide/protocol";
import { parseAgent } from "./agents.js";
import { CoreError } from "./errors.js";

const MAX_BYTES = 256 * 1024;
export const SKILL_TEMPLATE = "---\nname: New Skill\ndescription: Describe when to use this skill.\n---\n\nDescribe the workflow and instructions here.\n";

/** Core owns discovery, project policy and instruction loading for all providers. */
export class SkillsStore {
  constructor(private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces"), private readonly rootWorkspace?: string) {}

  private directory(scope: SkillScope, workspace: string): string {
    if (scope === "global") return path.join(this.stateDirectory, "skills", "global");
    if (scope === "local") {
      const key = crypto.createHash("sha256").update(this.rootWorkspace ?? workspace).digest("hex");
      return path.join(this.stateDirectory, "skills", "local", key);
    }
    return path.join(workspace, ".agents", "skills");
  }

  private async storedPolicy(workspace: string): Promise<{ content: string; path: string; storage: "local" | "workspace" } | undefined> {
    const candidates = [
      { path: path.join(this.directory("local", workspace), "skills.json"), workspace, storage: "local" as const },
      ...[...new Set([this.rootWorkspace ?? workspace, workspace])].map((root) => ({ path: path.join(root, ".agents", "skills.json"), workspace: root, storage: "workspace" as const }))
    ];
    for (const candidate of candidates) {
      const target = await this.checked(candidate.path, candidate.workspace, candidate.storage);
      try { return { content: await readFile(target, "utf8"), path: target, storage: candidate.storage }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }

  private target(id: string, workspace: string): string {
    if (typeof id !== "string" || !/^(global|local|workspace)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new CoreError("INVALID_REQUEST", "Skill ID must be global/name, local/name or workspace/name using letters, numbers, underscores or hyphens");
    const [scope, name] = id.split("/");
    return path.join(this.directory(scope as SkillScope, workspace), name!, "SKILL.md");
  }

  /** Reject symlink escapes, including paths used for new files. */
  private async checked(target: string, workspace: string, scope: SkillScope): Promise<string> {
    const boundary = scope === "workspace" ? path.resolve(workspace) : path.resolve(this.stateDirectory);
    const root = await realpath(boundary).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return boundary; throw error; });
    let ancestor = target;
    while (true) {
      try {
        const resolved = await realpath(ancestor);
        const effective = path.resolve(resolved, path.relative(ancestor, target));
        if (effective !== root && !effective.startsWith(`${root}${path.sep}`)) throw new CoreError("INVALID_REQUEST", "Skill path escapes its scope");
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  async read(id: string, workspace: string): Promise<string> {
    const target = await this.checked(this.target(id, workspace), workspace, id.split("/", 1)[0] as SkillScope);
    if ((await stat(target)).size > MAX_BYTES) throw new CoreError("FILE_TOO_LARGE", "Skill exceeds 256 KB");
    return readFile(target, "utf8");
  }

  async list(workspace: string): Promise<SkillCatalog> {
    const skills: SkillFile[] = [];
    for (const scope of ["global", "local", "workspace"] as const) {
      const directory = await this.checked(this.directory(scope, workspace), workspace, scope);
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(entry.name)) continue;
        const id = `${scope}/${entry.name}`;
        try {
          const parsed = parseAgent(entry.name, await this.read(id, workspace));
          skills.push({ id, scope, name: entry.name, title: parsed.name, description: parsed.description, path: this.target(id, workspace) });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    skills.sort((a, b) => a.scope.localeCompare(b.scope) || a.title.localeCompare(b.title));
    const storedPolicy = await this.storedPolicy(workspace);
    const checkoutIds = Object.fromEntries(skills.filter((skill) => skill.scope === "workspace").map((skill) => [`local/${skill.name}`, skill.id]));
    const legacyIds = Object.fromEntries(Object.entries(checkoutIds).filter(([id]) => !skills.some((skill) => skill.id === id)));
    let policy: SkillPolicy;
    try {
      const stored = storedPolicy ? JSON.parse(storedPolicy.content) : { allowed: skills.map((skill) => skill.id), defaults: [], scopeVersion: 2 };
      policy = this.validatePolicy(stored);
      if (stored.scopeVersion !== 2) {
        const resolve = (id: string) => checkoutIds[id] ?? id;
        policy = { allowed: [...new Set(policy.allowed.map(resolve))], defaults: [...new Set(policy.defaults.map(resolve))], ...(policy.agents ? { agents: Object.fromEntries(Object.entries(policy.agents).map(([id, choices]) => [resolve(id), choices])) } : {}) };
      }
    }
    catch (error) {
      throw new CoreError("INVALID_REQUEST", `Invalid skill policy (${storedPolicy?.path}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return { skills, policy, policyStorage: storedPolicy?.storage ?? "local", ...(Object.keys(legacyIds).length ? { legacyIds } : {}) };
  }

  private validatePolicy(value: SkillPolicy): SkillPolicy {
    if (!value || !Array.isArray(value.allowed) || !Array.isArray(value.defaults) || [...value.allowed, ...value.defaults].some((id) => typeof id !== "string" || !/^(global|local|workspace)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) || value.defaults.some((id) => !value.allowed.includes(id))) throw new CoreError("INVALID_REQUEST", "Skill policy needs allowed/defaults arrays; defaults must be allowed");
    if (value.agents !== undefined) {
      if (!value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new CoreError("INVALID_REQUEST", "Skill agents must be a map of skill IDs to agent choices");
      for (const [id, choices] of Object.entries(value.agents)) {
        this.target(id, process.cwd());
        if (!Array.isArray(choices) || choices.some((choice) => choice !== null && (!choice || !["global", "local", "workspace"].includes(choice.scope) || typeof choice.name !== "string" || !choice.name || choice.name.length > 180 || choice.name !== path.basename(choice.name) || choice.name.includes("\0") || !/\.md$/i.test(choice.name)))) throw new CoreError("INVALID_REQUEST", "Skill agent choices must be scoped Markdown preset references or null for no agent");
      }
    }
    return { allowed: [...new Set(value.allowed)], defaults: [...new Set(value.defaults)], ...(value.agents === undefined ? {} : { agents: value.agents }) };
  }

  async writePolicy(workspace: string, policy: SkillPolicy): Promise<void> {
    const validated = this.validatePolicy(policy);
    const previous = await this.storedPolicy(workspace);
    const target = await this.checked(path.join(this.directory("local", workspace), "skills.json"), workspace, "local");
    await mkdir(path.dirname(target), { recursive: true });
    await this.replace(target, `${JSON.stringify({ ...validated, scopeVersion: 2 }, null, 2)}\n`);
    // Remove an imported checkout policy only after persisting its settings outside Git.
    // Retain the source if another editor changed it during the write.
    if (previous?.storage === "workspace" && await readFile(previous.path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) === previous.content) await rm(previous.path, { force: true });
  }

  async movePolicyToLocal(workspace: string): Promise<void> {
    const catalog = await this.list(workspace);
    if (catalog.policyStorage === "workspace") await this.writePolicy(workspace, catalog.policy);
  }

  async write(id: string, workspace: string, content: string): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) throw new CoreError("FILE_TOO_LARGE", "Skill exceeds 256 KB");
    const target = await this.checked(this.target(id, workspace), workspace, id.split("/", 1)[0] as SkillScope);
    await mkdir(path.dirname(target), { recursive: true });
    await this.replace(target, content);
  }

  private async replace(target: string, content: string): Promise<void> {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, content, "utf8"); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }

  async delete(id: string, workspace: string): Promise<void> {
    const target = await this.checked(this.target(id, workspace), workspace, id.split("/", 1)[0] as SkillScope);
    // Supporting files are retained; only the instruction file is removed.
    await rm(target);
  }

  async validateSelection(workspace: string, ids: string[], agent?: AiAgentPreset | null): Promise<string[]> {
    const catalog = await this.list(workspace);
    if (!Array.isArray(ids)) throw new CoreError("INVALID_REQUEST", "Selected skills must be an array");
    ids = resolveSkillIds(catalog, ids);
    if (ids.some((id) => !skillAllowedForAgent(catalog.policy, id, agent) || !catalog.skills.some((skill) => skill.id === id))) throw new CoreError("INVALID_REQUEST", "Selected skill is missing or not allowed by this project for the selected agent");
    return [...new Set(ids)];
  }

  async defaults(workspace: string): Promise<string[]> {
    const { skills, policy } = await this.list(workspace);
    return policy.defaults.filter((id) => skills.some((skill) => skill.id === id));
  }

  async instructions(workspace: string, ids: string[], agent?: AiAgentPreset | null): Promise<string> {
    const catalog = await this.list(workspace);
    const { skills, policy } = catalog;
    ids = resolveSkillIds(catalog, ids);
    const enabled = skills.filter((skill) => ids.includes(skill.id) && skillAllowedForAgent(policy, skill.id, agent));
    const blocks = await Promise.all(enabled.map(async (skill) => `Skill: ${skill.id}\nBase directory: ${path.dirname(skill.path)}\n${await this.read(skill.id, workspace)}`));
    if (blocks.join("\n").length > 100_000) throw new CoreError("FILE_TOO_LARGE", "Enabled skills exceed the 100,000 character instruction limit");
    return ["For this turn, use only these Vibe-selected skills. Previously selected skills are inactive unless listed below. Follow supporting file references relative to each skill's base directory.", ...(blocks.length ? blocks : ["No Vibe skills are enabled."])].join("\n\n");
  }
}
