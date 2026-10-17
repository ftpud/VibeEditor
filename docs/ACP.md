# ACP: the AI provider abstraction

## Installing providers

Provider agents are not bundled with Vibe Editor. **Settings → AI providers** installs, updates and deletes Codex, Claude and Copilot on the Core host, and checks each provider's account. Only installed providers are returned by `ai.providers`, so pickers, chats and workflows offer only those; launching an uninstalled provider fails with a message pointing to the panel.

| Provider | npm package | Agent entry |
| --- | --- | --- |
| Codex | `@agentclientprotocol/codex-acp` (depends on its compatible `@openai/codex` CLI) | `dist/index.js` |
| Claude | `@agentclientprotocol/claude-agent-acp` (bundles the Claude Code CLI) | `dist/index.js` |
| Copilot | `@github/copilot` | `npm-loader.js` |

Core installs the `latest` published version into a fresh directory under `~/.remote-ide/provider-runtimes/<provider>/` (`REMOTE_IDE_PROVIDER_RUNTIME_DIR` relocates it) and starts the agent with Core's own Node. A completed installation is selected atomically through `current.json`; a failed install or update keeps the previous one. Update replaces the selection and keeps the previous directory, because running agents may still use it. Delete unpublishes the provider before removing its files; provider sign-in and chat history stay. Installation runs in the background: `ai.installations.install` and `ai.installations.uninstall` return immediately, and Desktop polls `ai.installations.list` (`checkLatest: true` asks npm for the latest version, cached for ten minutes).

Core-host overrides count as installed and cannot be managed from the client: `CODEX_ACP_COMMAND` (Codex adapter command; `CODEX_PATH` selects the CLI), `CLAUDE_AGENT_ACP_PATH` (adapter entry script) or `CLAUDE_ACP_COMMAND`, and `COPILOT_CLI_PATH`. Codex account-quota reads use the CLI belonging to the installed adapter, or `CODEX_PATH`; usage polling never installs anything.

### Claude credentials

Claude Code prefers `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) over a subscription login whenever the variable is set, so a key exported in a shell profile silently bills that API account. **Settings → AI providers → Credentials** on Claude's card chooses between **API key from environment** (the default, unchanged behaviour) and **Subscription login**, which starts Claude's agent — for chats, account checks and sign-in — without those variables. The card names the variables that are set on the Core host (never their values). Idle agents restart with the new choice; it is stored with the provider's settings on the Core host.

## ACP v2 (experimental)

Codex and Claude can use the experimental **draft ACP v2** instead of v1. Choose it per provider under **Settings → AI providers → Protocol**; the setting is stored on the Core host (`provider-runtimes/<provider>/settings.json`) and survives Delete. Idle agents reconnect with the new protocol on their next prompt and resume their saved session; a running turn finishes first.

- **Claude:** the released adapter serves v2 when Core launches it with `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`, which Core sets for v2.
- **Codex:** only preview builds serve v2. With v2 selected, Install and Update use the `preview` npm channel (switching back to v1 makes Update return to `latest`).
- An agent that negotiates v1 when v2 was requested fails with a message to switch back or update the adapter.
- Workflow AI and Chatbox sessions on a v2 provider get an extra instruction not to end their turn while waiting on background work, and to wait or poll inside the turn instead, because a workflow step ends with the turn.

Core's v2 client (`core/src/ai/acp-v2.ts`) exposes the same calls as the v1 SDK connection, so the provider runtime, transcripts, permissions and questions are shared. It translates the v2 lifecycle: `session/prompt` only acknowledges a prompt and the turn ends on an `idle` `state_update` (an `error` stop reason fails the turn); a `running` or `requires_action` state with no prompt waiting is a turn the agent started by itself, for example after background work it ended its previous turn waiting on finished, so Core shows that work as a live turn with an activity note and the session reports it as working until the next `idle`; tool calls are upserts plus content chunks; whole `agent_message` upserts are forwarded as the text they add; modes are the config option in the `mode` category; config options use `configId`; `session/load` becomes `session/resume` with replay from the start; live steering prefers the advertised `_session/steering` extension on either protocol, falling back to `session/prompt` for v2 agents without it. Ordinary v2 prompts can queue behind the active turn. Agent-owned terminal updates and subagent updates are not shown yet. The draft still changes between SDK releases, and agents ship different snapshots, so messages are parsed leniently rather than validated against one snapshot.

Transient OAuth refresh contention (another process refreshing the token or exiting
mid-refresh) is retried up to three times, after 5, 15 and 40 seconds, when opening
or resuming a session and when a prompt fails before producing output or starting
tools. Other authentication errors still require sign-in. Retry notices appear in
the conversation; interrupting or stopping the session cancels the backoff. Routine
adapter startup traces such as `[session/create]`, `[session/query]` and `[authStatus]`
are filtered from displayed errors while actionable stderr is retained.

## Signing in

The provider account control sits in **Settings → AI providers** and in the settings (cog) section of the AI panel and workflow Chatboxes. It discovers the agent's `initialize.authMethods`; the UI uses the advertised names and descriptions rather than provider-specific login commands. Account setup runs on the selected Core host, so local and remote workspaces use the credentials belonging to that host.

Checking an account (`ai.auth.get` with `discover: true`) initializes the agent and opens a session: success reports *signed in*, an ACP `auth_required` error (or equivalent message) reports *sign in to continue*, and other failures are shown as errors. The AI providers panel checks every installed provider when it opens.

For agent methods, Core calls ACP `authenticate`. URL elicitations appear as explicit browser links with a confirmation button. For terminal methods, Core starts the agent command with its advertised authentication arguments and environment in a dedicated interactive terminal. A successful terminal exit is checked by opening a fresh ACP session. Terminal methods do not call `authenticate`.

Desktop uses `ai.auth.get`, `ai.auth.start` (`methodId`), and `ai.auth.input` (`requestId` plus terminal `data`, `cols`/`rows`, or `action: "accept" | "cancel"`). Each active request belongs to one workspace and provider. Cancellation, shutdown, and a ten-minute timeout terminate the authentication processes. Discovery is shared across simultaneous requests. Browser links accept HTTP and HTTPS only and require a user click.

Authentication output is bounded, held in memory, and cleared on success. It is not added to chat history or saved workspace configuration. Provider tools manage their own credential storage. Agents without advertised authentication methods continue to use their existing Core-host login or environment configuration.

Vibe Editor uses one interface for Codex, GitHub Copilot, and Claude. Core handles each
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

Codex ACP may lag the Codex CLI release, so Core offers GPT-6 Sol even when ACP's model catalogue has not advertised it yet.

Codex, Claude and Copilot are updated only from **Settings → AI providers**; Core does not update provider agents on its own.

Copilot discovers models from ACP configuration metadata, including the premium-request multiplier, cost tier, and availability published in the model option's `_meta`. Stored model and reasoning choices are passed at server launch and are also applied when their dynamic ACP options arrive. Copilot exposes a client-owned Autopilot toggle. When enabled, Core selects an advertised allow option for ACP tool permission requests; it prefers allow-once so disabling Autopilot restores prompting for subsequent requests. Enabling it during a pending permission request also approves that request without restarting the session. A per-session AI-credit ceiling remains available. Copilot documents quota details in interactive `/usage`; the shared usage view displays the context and latest-turn token data ACP reports.

Claude runs through `@agentclientprotocol/claude-agent-acp`, installed from Settings → AI providers, which bundles the Claude Code CLI through the Claude Agent SDK. It uses the existing Claude Code login on the Core host (or `ANTHROPIC_API_KEY`, Bedrock and Vertex variables in Core's environment). Models, effort levels, and extra switches such as fast mode come from the agent's ACP configuration options. The permission mode (Manual, Accept edits, Plan, Auto, Bypass permissions) is applied as a session-scoped ACP mode; modes the agent does not advertise for a session are skipped with a warning. Claude also exposes the client-owned Autopilot toggle. When Claude reports subscription rate limits with a turn (`_claude/rateLimit` on `usage_update`), the usage view lists each window and the account quota carries the 5-hour window as primary and the weekly window as secondary, which workflow watchdogs use to schedule recovery. These windows appear only after the agent reports them. `CLAUDE_CODE_EXECUTABLE` overrides the adapter's CLI and `CLAUDE_AGENT_ACP_PATH` overrides the adapter entry point.

## Session features

Providers list shared feature switches from `stdio-provider.ts` in their option schema, so they appear in the AI chat settings:

| Switch | Default | Providers | Behavior |
| --- | --- | --- | --- |
| Questions (`askQuestions`) | Off | Claude, Codex | Declares ACP form elicitation, so the agent may pause a turn and ask a multiple-choice or free-text question (Claude's AskUserQuestion, Codex's user-input requests, MCP elicitations). When off, nothing is declared and agents drop those tools rather than wait. Changing it restarts and resumes the session. |
| Steer running turns (`liveSteering`) | On | Claude, Codex | Messages sent while the agent works join the running turn: through `_session/steering`, or by sending another `session/prompt` to agents that advertise prompt queueing (Claude). The turn settles after every steered prompt. When off, messages wait and run as the next turn. Applied live. |
| Agent presets as system instructions (`agentSystemInstructions`) | On | Claude | The selected preset is sent as session `_meta.systemPrompt.append` on `session/new` and `session/load`, so it survives compaction and resumes. A send without an agent keeps it; another preset restarts and resumes the session with the new text. When off, or for agents without this extension, the preset is sent inside the first prompt. |

Options marked `interactive` wait for a person. They default to off and workflow sessions always force them off, so a Chatbox or AI block never blocks on a question. The workflow Chatbox settings show only non-interactive boolean switches next to Autopilot; their values are saved as the block run's `options` and applied on the next message. Options marked `client` are handled by Core and change without restarting the agent.

A pending question is `AiSession.pendingQuestion`; the desktop answers it with `ai.question.answer` (accept with typed values, decline, or cancel). Core validates answers against the field types and choices the agent sent. Interrupting the turn or stopping the agent cancels the question.

## Model catalogue metadata

`AiModel` carries optional catalogue details beside the id and name: `description`, `price` and `priceTier` (relative request cost), `available`, `contextWindow` and `maxContextWindow`, `inputModalities`, per-level `reasoningDescriptions`, and a free-form `note` for deprecations. Providers fill in only what their agent publishes — ACP itself mandates nothing beyond id, name, and description — and the desktop model picker renders whatever is present. Agents that report a context window only per turn (`usage_update`) have it recorded against the selected model as it is observed. Provider adapters can add facts the handshake omits by overriding `describeModels`.

## Common request extensions

`ai.send` accepts typed `content` blocks (text, base64 images, embedded text resources, and resource links) plus optional `mcpServers` and `agent` fields. MCP supports stdio, HTTP, and SSE records. Environment variables and HTTP headers may contain secrets, so callers should retrieve them from secure local storage and must not persist them in workspace settings. Provider options live in the session's `configuration` map and are rendered from the option schema. Boolean options marked `permissionApproval` are handled by the ACP client and can change while the provider is working. Workflow AI and Chatbox blocks enable Autopilot by default when the provider exposes it; block design can disable that default, and the Chatbox settings panel can toggle it for the existing conversation.

Core disables workspace snapshots for workflow AI blocks connected as helpers through incoming `use` edges. This applies to their initial prompts, follow-up prompts, and steering, including after workflow recovery. The lead and ordinary AI-tab sessions retain snapshots; helper transcripts and workflow operation records are still saved. The internal `AcpSendRequest.captureSnapshots` flag controls snapshot creation, is retained for follow-ups in the live session, and defaults to enabled for new sessions.

`StdioAcpProvider` is a real Agent Client Protocol v1 NDJSON transport. It surfaces blocking permission requests through `ai.permission.resolve`, stores complete dynamic command snapshots for slash completion, renders rich image/resource output, resumes saved sessions, and applies session-scoped configuration without restarting the process. Launch-scoped changes restart the process and resume the saved session when supported.

## Context inspector

Click the context pie beside the AI chat session control, or in a workflow
Chatbox header, to expand the context inspector beneath the header. The pie and
usage history show ACP-reported context tokens, independently of account quotas.
The history retains the latest 120 usage updates, including decreases, and uses
an automatic vertical scale. Hover a history bar for its timestamp and values.
When usage is unavailable, the neutral pie still opens the captured history.

Colored segments break down captured instructions, prompts/replies, file text,
tool activity and reported reasoning. Click a segment or legend to inspect recent
items, largest first. These are estimates based on four characters per token,
not a reconstruction of the model's current input. Core counts retained message
text (up to 1,000 messages), records injected agent instructions and skill
catalogues, and keeps up to 12 previews of 1,600 characters per category. Tool
updates replace their previous captured contribution rather than adding another
copy. Images and unresolved resource links have no text token estimate. Capture
does not fetch files or add anything to the model prompt.

Provider system instructions, hidden tool schemas, unreported file reads and the
exact history retained after compaction are unavailable through this view.
Captured history can therefore exceed or fall short of reported current usage.
Compaction notifications are counted when supplied by the adapter. Data is saved
with the session and propagated into workflow block state; fresh sessions start
new usage histories. Existing sessions begin collecting details on new activity.

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

The left **Triggers** tool window is the reactive counterpart of schedules. A trigger watches a file or folder (created, changed and/or deleted, polled once per second) or a named pipe (FIFO, created with `mkfifo` when missing; each write fires it), then sends a prompt or starts a workflow in the root workspace or an active task, with the same choices as schedules: a prompt either continues the provider's current session or starts a new one (only then can an agent preset, model and reasoning effort be chosen), and a workflow needs only its start block. The event description and, for pipes, the received text are appended to the prompt or workflow input. Events are grouped until a quiet period (default 2 s) passes; events are skipped, not queued, while the target agent is busy or the previous workflow run is still active; and a trigger that fires more than its hourly limit (default 20) disables itself to stop feedback loops. Triggers are persisted separately, re-armed when Core starts, and never replay changes made while Core was stopped. Pipes are not supported on Windows. The Vibe Configurator agent can create and edit triggers through `triggers/{id}.json` (start from `triggers/new.json`); deletion stays in the panel.

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
The skill links supporting references covering every workflow block and connection,
document formats and examples, and the complete app/flow command schemas. Core
installs these beside the skill; agents read them relative to its `baseDirectory`.
Terminal Control guidance reserves persistent terminals for work that may need
interaction, with Script for finite commands and Run App for managed services.

Three generic MCP tools expose logical configuration documents instead of private
registry paths:

- `configuration_list` lists document resource names, formats and provider metadata.
  Set `include_models: true` when choosing provider/model settings for AI workflows.
- `configuration_read` returns `content`, `exists` and a `revision` for a resource.
  Existing skill documents also include `baseDirectory` for resolving supporting files.
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
