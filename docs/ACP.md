# ACP: the AI provider abstraction

Vibe Editor uses one interface for Codex and GitHub Copilot. Core handles each
provider through `AcpProvider`; Desktop reads the provider's capabilities and
settings to build the AI controls. Adding a provider should not require special
cases in the UI or shared protocol.

## Provider contract

An ACP plugin supplies:

- a stable id, display name, capability flags, and provider-defined option schema;
- model discovery, resumable session persistence, configuration, typed-content send, permission resolution, clear, and optional usage operations;
- translation of the common MCP server and custom-agent structures to its native CLI/API.

To add a provider, subclass `AcpProvider`, implement its required session/model/configuration operations under `ai/providers`, and register one instance in `ai/index.ts`. `AiProvider` is an open string, and the desktop builds its provider selector and extra controls from `ai.providers`, so no protocol or UI enum needs editing.

## Current adapters

Codex discovers model and reasoning metadata from its local model cache, which also supplies context window sizes, input modalities, and retirement notices for the models advertised over ACP. Its ACP options expose sandbox and web search. Saved session ids are loaded when the agent advertises `loadSession`; loaded history replaces the local transcript. MCP definitions are supplied during session setup and selected custom-agent presets can restrict the enabled MCP set.

Codex ACP may lag the Codex CLI release. The root npm override keeps ACP's bundled CLI on a version that can run GPT-6 Sol even when ACP's model catalogue has not advertised it yet.

At Core process startup, Vibe checks npm's `latest` versions of `@agentclientprotocol/codex-acp` and `@openai/codex` before accepting connections. Changed versions are installed into a new directory under `~/.remote-ide/codex-runtime`; a completed installation is selected atomically without changing the project's dependencies or lockfile. Both ACP sessions and quota reads use this runtime. Registry requests have a 15-second fetch timeout and each npm command has a 60-second limit. An offline or failed update logs a warning and retains the previous cached runtime, or the bundled dependency on first startup. Set `REMOTE_IDE_CODEX_AUTO_UPDATE=0` to skip updates, or `REMOTE_IDE_CODEX_RUNTIME_DIR` to relocate the cache. An explicit `CODEX_PATH` still overrides the Codex binary for ACP sessions. Updating removes a source of stale model catalogues; model access still depends on the account and what the agent advertises.

Copilot discovers models from ACP configuration metadata, including the premium-request multiplier, cost tier, and availability published in the model option's `_meta`. Stored model and reasoning choices are passed at server launch and are also applied when their dynamic ACP options arrive. A per-session AI-credit ceiling remains available. Copilot documents quota details in interactive `/usage`; the shared usage view displays the context and latest-turn token data ACP reports.

## Model catalogue metadata

`AiModel` carries optional catalogue details beside the id and name: `description`, `price` and `priceTier` (relative request cost), `available`, `contextWindow` and `maxContextWindow`, `inputModalities`, per-level `reasoningDescriptions`, and a free-form `note` for deprecations. Providers fill in only what their agent publishes — ACP itself mandates nothing beyond id, name, and description — and the desktop model picker renders whatever is present. Agents that report a context window only per turn (`usage_update`) have it recorded against the selected model as it is observed. Provider adapters can add facts the handshake omits by overriding `describeModels`.

## Common request extensions

`ai.send` accepts typed `content` blocks (text, base64 images, embedded text resources, and resource links) plus optional `mcpServers` and `agent` fields. MCP supports stdio, HTTP, and SSE records. Environment variables and HTTP headers may contain secrets, so callers should retrieve them from secure local storage and must not persist them in workspace settings. Provider options live in the session's `configuration` map and are rendered from the option schema.

`StdioAcpProvider` is a real Agent Client Protocol v1 NDJSON transport. It surfaces blocking permission requests through `ai.permission.resolve`, stores complete dynamic command snapshots for slash completion, renders rich image/resource output, resumes saved sessions, and applies session-scoped configuration without restarting the process. Launch-scoped changes restart the process and resume the saved session when supported.

## Starting tasks through the Vibe Editor MCP server

In this API, an **agent** is a Vibe Editor instruction preset, not the Codex or Copilot process that executes a task. `provider` selects that execution backend, `model` selects its model, and `agent` optionally selects the Markdown preset whose instructions and MCP allowlist are attached to the new session.

Agent presets are Markdown files with optional YAML frontmatter. Create and edit global or repository-local presets in the Desktop **Agents** panel; repository-local presets are stored outside the checkout in Core's workspace state. A repository may also commit workspace presets under `.agents/*.md`. The scope names used by MCP are:

- `global` — a preset available to every workspace;
- `local` — a preset configured for this root repository;
- `workspace` — a preset from the active workspace's `.agents` directory.

For example, `.agents/reviewer.md` can contain:

```markdown
---
name: Code Reviewer
description: Reviews implementation and tests.
mcpServers: []
---

Review the requested change, run focused checks, and report concrete findings.
```

Add `vibe-editor` under `mcpServers` when the started task should itself receive the built-in Vibe Editor MCP tools. An empty or omitted `mcpServers` list gives the preset no built-in task tools.

`task_create_and_start` accepts `agent` as either a precise `{ "scope", "name" }` file reference or JSON `null`:

- omit `agent` to inherit the invoking AI session's selected preset, if it has one;
- pass a reference to choose a configured preset explicitly;
- pass `"agent": null` to suppress inherited preset instructions and start only the requested provider/model session.

An empty string is not a no-agent value. References use the file name, including `.md`, rather than the preset's frontmatter display name. Missing or changed presets are rejected before a task worktree is created.

`reasoning` is also optional. When omitted, normal provider/model default selection is preserved. An explicit value overrides that default and must occur in the selected model's advertised `reasoningLevels`; supported values are model- and provider-specific and may include values such as `none`, `low`, `medium`, `high`, `xhigh`, or `max`. Models that advertise no reasoning levels require the field to be omitted. Invalid model/reasoning combinations are rejected before task creation.

Create a task with a configured preset and explicit reasoning:

```json
{
  "name": "task_create_and_start",
  "arguments": {
    "branch": "feature/review-fix",
    "prompt": "Implement the review fix and add regression tests.",
    "provider": "codex",
    "model": "gpt-5.6-sol",
    "agent": { "scope": "workspace", "name": "reviewer.md" },
    "reasoning": "high"
  }
}
```

Create a task with no agent preset and the provider/model's default reasoning:

```json
{
  "name": "task_create_and_start",
  "arguments": {
    "prompt": "Update the dependency and run its tests.",
    "provider": "copilot",
    "model": "claude-sonnet-5",
    "agent": null
  }
}
```

Existing callers that send only `prompt`, `provider`, and `model` remain valid. There is currently no separate MCP tool for starting an existing idle task: `task_append_prompt` steers a running task or starts a follow-up turn with that task's persisted session configuration, so it does not accept a new `agent` or `reasoning` selection.

Agents with the `vibe-editor` MCP server can call `ai_usage` to inspect the invoking provider's current session. The result contains `used`, `limit`, computed `remaining`, `unit`, and `resets_at`; unavailable values are returned as `null`. `kind: "context_window"` means those top-level numbers describe conversation capacity. When available, `account_quota` separately reports the plan plus primary and secondary rolling windows, including used/remaining percentages and reset times. Codex retrieves this snapshot from its authenticated app-server `account/rateLimits/read` endpoint; other ACP providers may leave it `null`.

The `timer_set` MCP tool lets an agent schedule one continuation for its current task and provider. It accepts `seconds` (1 through 604800) and a `prompt`; setting another timer replaces the existing timer for that task/provider. Timers are persisted by Core and recovered after restart. Once the current turn finishes, task summaries report `status: "waiting"` and `waitingUntil` until Core sends the continuation prompt. Deleting a task cancels its timers. The left **Timers** tool window lists all continuation timers in the Core workspace group, including internal workflow sessions, with their prompt, due time, and individual run/cancel controls. AI Stop also cancels pending continuation timers for that workspace/provider.

The same window supports user-created one-time and recurring schedules. A schedule targets a root workspace or an active task and either starts a workflow (with an optional start block) or sends a prompt through a chosen provider and agent preset. These schedules are persisted separately from agent continuation timers. They can be run now, paused, resumed, or deleted; **Cancel all** cancels continuation timers and pauses enabled user schedules. Core must be running to execute them. After downtime, an overdue schedule runs once rather than replaying every missed interval. A busy prompt target, overlapping scheduled workflow, missing target/preset, or failed launch pauses the schedule with a visible error. Claims are saved before launch to avoid replaying one-time actions after a crash; a crash between the claim and launch can skip that occurrence.

`model_switch_next` queues a one-shot `model` and `reasoning` override for the invoking provider session. Both values are required and validated together against the provider's current model catalogue. It never changes the turn that calls it; when called during a running turn, it automatically queues a continuation, and that newly started turn consumes the override, replacing UI/default configuration for that turn only. Calling the tool again before consumption replaces the pending override. Generated assistant messages record their effective model so later configuration changes do not rewrite response provenance.

`session_new` deliberately refreshes the invoking agent's context without creating a task or worktree. It accepts a self-contained `prompt`, waits for the MCP-calling turn to finish, archives the old conversation, creates a context-empty session in the same workspace and provider with the same configuration and selected agent preset, and sends the handoff prompt as that session's first message. Requesting a fresh session supersedes ordinary queued follow-ups.

## Project skills

Skills are reusable instruction folders that can be combined with an agent preset.
Open **Skills** on the right tool stripe, beneath **Agents**, to create and edit
skills, allow them in the current project, or enable them by default for new chats.
The panel separates **Global** skills (`$REMOTE_IDE_STATE_DIR/skills/global/<name>/SKILL.md`),
**Local** skills (`$REMOTE_IDE_STATE_DIR/skills/local/<root-project-hash>/<name>/SKILL.md`)
and **Workspace** skills (`.agents/skills/<name>/SKILL.md` in the current checkout).
Local skills use the same root-project scope as local agents and are shared by all
tasks of that project. Other projects have their own local skills. When unset,
`REMOTE_IDE_STATE_DIR` defaults to `~/.remote-ide/workspaces`. Supporting files can live alongside `SKILL.md`; each
turn supplies the skill's base directory so the agent can resolve references.
Deleting a skill in the panel removes its instructions and retains supporting files.

A skill can use the same simple name/description frontmatter as an agent preset:

```markdown
---
name: Code Review
description: Review changes for regressions and missing tests.
---

Inspect the diff, check behavior at boundaries, and run focused tests.
```

Project availability, defaults and agent assignments are stored outside Git in
`$REMOTE_IDE_STATE_DIR/skills/local/<root-project-hash>/skills.json`, shared by all tasks.
Existing `.agents/skills.json` files remain readable until you use **Move settings
out of Git repo** in the Skills panel or save policy changes. Core saves the settings
in its state directory before removing the imported checkout file. New policies
use `scopeVersion: 2`; older checkout skill IDs and selections remain compatible
with the Workspace scope until a matching project-local skill is created:

```json
{
  "scopeVersion": 2,
  "allowed": ["global/reviewer", "local/testing"],
  "defaults": ["local/testing"]
}
```

IDs include their scope, so global, local and workspace skills with the same folder name
remain distinct. Without a policy file, all discovered skills are available and
none are enabled by default. Once a policy exists, new skills must be explicitly
allowed. Commit workspace skill folders to share them with the team and task worktrees.
Policy stays on Core; edits apply to every task of the root project. Global and local skill contents stay on Core and are not committed;
each Core host needs its own copy of global skills referenced by the policy.

The chatbox's **Skills** checklist and removable chips change the current chat's
selection. Core persists this selection with the session, including archived
sessions; changing project defaults does not modify existing chats. New chats
use the current defaults. Creating a task from the chat copies its selection;
local skills are shared from Core state; workspace skills must exist in the task
worktree (commit them first).

Selected skills are available on demand. The first turn in a provider conversation
receives a compact catalogue of IDs, names, descriptions and revisions, without
skill bodies. The agent calls **skill_load** on the dedicated **vibe-skills** MCP
server when a skill is relevant. Core returns the current `SKILL.md`, its revision
and base directory for supporting files. This server exposes only skill loading,
so enabling skills does not grant other app tools.

Unchanged prompts include no skill data. When selections, content, metadata or
policy change, the next turn receives only additions, updates and removed IDs.
Updates tell the agent to reload a previously loaded skill before applying it;
removals tell it to stop using that skill. Queued turns use the latest catalogue;
steering an active turn does not send catalogue changes. Core persists the sent
catalogue per provider conversation, so a successfully resumed session receives
only subsequent changes. Fresh or failed-to-resume conversations receive an
initial catalogue. Skill-load requests check the turn's advertised catalogue and
current project/agent policy; deleted, revoked and unadvertised skills are rejected.
Previously loaded text can remain in history; start a new chat for a clean reset.
Availability controls Vibe's skill interface, not independent filesystem access.

The provider-neutral `skills.*` operations handle catalogue editing and project
policy. `ai.skills` sets the selection with a session ID guard. Both current stdio
adapters share catalogue synchronization and on-demand loading. This does not
install provider plugins or automatically execute scripts bundled with a skill.

Each skill's **Agents** section controls which presets may use it. **Any agent**
keeps it available with every preset and with no preset. Clear that option to
choose specific Global, Local or Workspace agent presets, and/or **No agent**.
An empty selection makes the skill unavailable to all chats. These assignments
are project policy, so the same global skill can have different assignments in
different projects. The chat checklist and active chips show only skills allowed
for the currently selected preset. Hidden selections remain stored but their
instructions are omitted; switching back can make them active again.

Assignments use exact preset scope/file references and persist in the optional
`agents` map in the project-local skill policy. `null` permits a chat without a preset:

```json
{
  "scopeVersion": 2,
  "allowed": ["global/reviewer", "local/testing"],
  "defaults": ["local/testing"],
  "agents": {
    "global/reviewer": [{ "scope": "workspace", "name": "reviewer.md" }],
    "local/testing": [null, { "scope": "local", "name": "developer.md" }]
  }
}
```

A skill omitted from the `agents` map retains **Any agent** access. Renaming a
preset does not rewrite skill policy; update its assignment to the new
preset name. Core checks these assignments on selection and on every new turn,
including queued follow-ups.

## Self-configuration through MCP

Core ships a global **Vibe Configurator** agent (`vibe-configurator.md`) and a global
**vibe-self-configuration** skill. They are installed on Core startup for every
project on that host. Existing custom versions are preserved; a missing shipped
file is recreated at startup. Choose the agent in the chatbox to configure the app
with natural language. Its `mcpServers: [vibe-editor]` preset grants access to the
built-in app tools. The agent reads the configuration skill through the same
configuration interface; projects can also allow/enable the skill in the Skills panel.

Three generic MCP tools expose logical configuration documents instead of private
registry paths:

- `configuration_list` lists document resource names, formats and provider metadata.
  Set `include_models: true` when choosing provider/model settings for AI workflows.
- `configuration_read` returns `content`, `exists` and a `revision` for a resource.
- `configuration_write` accepts `resource`, full-text `content`, and
  `expected_revision`. Supply the revision from the read; use JSON `null` to create
  a new agent, skill or useful file. A stale revision is rejected. Writes through
  this interface to the same document are serialized, including global edits from
  different projects. Workflow edits also retain native workflow version checks.

| Resource | Format and scope |
| --- | --- |
| `agents/global/reviewer.md` | Shared Core agent preset, Markdown |
| `agents/local/developer.md` | Root-project agent preset in Core state, Markdown |
| `agents/workspace/reviewer.md` | Invoking checkout's `.agents/reviewer.md`, Markdown |
| `skills/global/review/SKILL.md` | Shared Core skill instructions, Markdown |
| `skills/local/testing/SKILL.md` | Core state for the root project, shared across its tasks |
| `skills/workspace/testing/SKILL.md` | Invoking checkout's `.agents/skills/testing/SKILL.md` |
| `skills/policy.json` | Core project-local availability/defaults/agent assignments, shared by all tasks |
| `useful/global/reference.md` | Shared Core useful file, text |
| `useful/local/notes.md` | Root-project useful file in Core state, text |
| `workflows/<id>.json` | Root-project workflow definition, JSON |
| `tasks/<id>.json` | Task metadata: `name`, `status` and `archived`, JSON |

Read `workflows/new.json` for a starter definition; write its edited content with
`expected_revision: null` to create a workflow. The result contains the actual
resource ID and graph validation issues. Edit that returned resource thereafter.
Core validates the document structure before storing it. Graph issues are returned
separately so incomplete drafts remain editable; runtime validation still applies
when starting a workflow. Creating/updating definitions does not start runs.

For example, create a global agent preset:

```json
{
  "name": "configuration_write",
  "arguments": {
    "resource": "agents/global/reviewer.md",
    "content": "---\nname: Reviewer\ndescription: Review changes for regressions.\nmcpServers: [vibe-editor]\n---\n\nInspect changes and run focused tests.\n",
    "expected_revision": null
  }
}
```

Use the existing `task_create`, `task_create_and_start`, `task_append_prompt`,
`task_set_status`, `task_merge` and `task_delete` tools for worktree and execution
operations. Configuration documents cannot rewrite worktree paths, branches,
provider transcripts, raw registries or workflow-run state. The interface does
not expose provider credentials or MCP connection configuration. Creating a skill
does not automatically enable it or execute its supporting scripts.

Successful writes broadcast `configuration.changed`; Desktop refreshes its agents,
skills, useful files, workflows and tasks panels. Global changes refresh every
connected project's panels. Global here means projects sharing the same Core
state directory, rather than an installation across unrelated Core hosts.
