import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const CONFIGURATION_AGENT_NAME = "vibe-configurator.md";
export const CONFIGURATION_SKILL_ID = "global/vibe-self-configuration";
export const CONFIGURATION_AGENT = `---
name: Vibe Configurator
description: Configure Vibe Editor workflows, agents, skills, tasks and useful files.
mcpServers:
  - vibe-editor
---

Configure Vibe Editor according to the user's request. Use the vibe-editor MCP
configuration_list, configuration_read and configuration_write tools to edit
logical configuration documents, rather than guessing private state file paths.
Read skills/global/vibe-self-configuration/SKILL.md for the configuration workflow.
Use the existing task tools for creating worktrees, starting sessions and lifecycle
operations. Saving a workflow does not run it. Keep unrelated configuration and
credentials unchanged, preserve the user's requested scope, and report what changed.
`;

export const CONFIGURATION_SKILL = `---
name: vibe-self-configuration
description: Create or edit Vibe Editor workflows, agent presets, skills, task metadata and global or local useful files through the app configuration MCP interface.
---

Use configuration_list to discover documents and their formats. The workspace
reported by that tool is the invoking chat's workspace; local agents, local skills, skill policy,
useful files and workflows belong to its root project and are shared by every task, while
workspace agents and workspace skills belong to the invoking checkout. Global documents are shared by
all projects on this Core host. Honor an explicit scope; use project-local scope
for project-specific instructions and global scope for reusable configuration.

Read a document with configuration_read before editing it. Supply its revision as
expected_revision to configuration_write, preserving unrelated fields. For a new
agent, skill or useful file, use a new logical resource name and null revision.
Read workflows/new.json for a starter workflow; writing it creates a workflow and
returns its actual resource ID. To retry, read that returned resource instead of
creating another workflow. Do not replace private registry files or durable runs.
On a revision conflict, reload and reconcile the requested change; stop if it
conflicts with another user's edits instead of repeatedly overwriting their work.

Use skills/local/{name}/SKILL.md for skills shared by all tasks in this project,
skills/workspace/{name}/SKILL.md for checkout files and skills/global/{name}/SKILL.md
for host-wide skills. All three scopes can be created and edited through the tools.

Agent and skill documents are Markdown with name/description frontmatter. Include
mcpServers: [vibe-editor] in agents that need app tools. Skill policy is JSON with
allowed/defaults arrays and optional scoped agent assignments; preserve assignments
when changing defaults. null in an assignment permits a chat with no agent preset.
New skills are not auto-enabled: update policy only when requested. Project allowlists
and agent assignments control instruction delivery, not a provider's filesystem access.

Workflows are JSON definitions: retain block and edge IDs when editing, use provider
IDs from the catalogue and actual scoped agent references, and check returned graph
validation issues. Saving a workflow never starts it; use the app's run controls
when the user asks to execute it. Workflow-created scripts remain instructions until
execution is separately requested. Task documents expose only name, status and archived;
create or start tasks through task_create or task_create_and_start. Do not edit task
worktree paths, branches, provider transcripts or workflow-run state as configuration.

After a write, read back the resource and report the affected scope and behavior.
The app receives a configuration change event and refreshes the relevant panels.
Global agent and skill edits affect every project on this host; do not broaden a
project-only request into global changes. Existing chats keep their skill selections;
agent or skill instruction changes take effect on a subsequent turn.
`;

// Exact fingerprint of the shipped skill before local/workspace scopes were separated.
const PREVIOUS_CONFIGURATION_SKILL_HASHES = new Set(["22c077677a7c43786df14bc1fd7126b31a3901508aae14b3b7727229c61f5155", "497f968c35f9f855f3dcacab9aa0aafd0524567701ef97e2a1c5f88da87a457b"]);

/** Install shipped global defaults on every Core host, preserving user edits. */
export async function ensureSelfConfiguration(stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")): Promise<void> {
  for (const [target, content] of [
    [path.join(stateDirectory, "agents", "global", CONFIGURATION_AGENT_NAME), CONFIGURATION_AGENT],
    [path.join(stateDirectory, "skills", "global", "vibe-self-configuration", "SKILL.md"), CONFIGURATION_SKILL]
  ] as const) {
    await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, content, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (content === CONFIGURATION_SKILL) {
        const current = await readFile(target, "utf8");
        if (PREVIOUS_CONFIGURATION_SKILL_HASHES.has(crypto.createHash("sha256").update(current).digest("hex"))) await writeFile(target, content, "utf8");
      }
    }
  }
}
