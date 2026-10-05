# Internal MCP tools

The built-in `vibe-editor` MCP server lets an AI agent manage tasks and control its
Vibe Editor session. Workflow agents can also call tools for connected blocks. Core
owns the worktrees, processes, and saved state behind these tools.

This page covers Vibe's internal tools. For the Codex/Copilot abstraction and
provider transport, see [ACP](ACP.md).

## Enable the tools

Select an agent preset whose `mcpServers` allowlist includes `vibe-editor`. An empty
or omitted list does not enable the built-in server. Presets can be managed in the
Desktop **Agents** panel or committed under `.agents/*.md`.

## Tool reference

Arguments shown without `?` are required. `?` means optional. Tool names and schemas
are defined in `packages/core/src/app-tools.ts`; workflow behavior is implemented in
`packages/core/src/harness-runner.ts`.

### Tasks and Git

| Tool | Arguments | What it does |
| --- | --- | --- |
| `task_create` | `branch`, `idempotency_key?` | Create a task worktree without starting an agent. |
| `task_create_and_start` | `prompt`, `provider`, `model`, `branch?`, `agent?`, `reasoning?`, `feature_id?`, `idempotency_key?` | Create a worktree and start its AI session. Omit `branch` to generate one. |
| `task_list` | None | List tasks with aggregate and per-provider AI status. |
| `task_ai_response_tail` | `task_id`, `provider`, `messages` | Read the latest 1–100 conversation messages and session status. |
| `task_append_prompt` | `task_id`, `provider`, `prompt`, `idempotency_key?` | Steer a running task or start a follow-up turn using its saved configuration. |
| `task_merge` | `task_id`, `strategy?`, `idempotency_key?` | Commit outstanding task changes, merge into the root workspace, and mark the task finished. Default `smart` preserves root changes; `merge` is for a clean root. |
| `task_set_status` | `task_id`, `status` | Set `active` or `finished` without merging or deleting the task. |
| `task_delete` | `task_id` | Delete the task, its worktree, its branch, and its continuation timers. |
| `set_commit_message` | `message` | Set the current task's commit-message draft; this does not commit. |
| `task_update_commit_message` | `task_id`, `message` | Rewrite the latest unpushed commit message on that task branch. Commit contents and working files stay unchanged; unsafe published-history rewrites are rejected. |

Both commit-message tools accept multiline text with at least one non-whitespace
character, up to 10,000 characters. Use task IDs returned by creation or listing.
Marking a task finished keeps its worktree available; deleting it removes it.

### Usage, timers, and sessions

| Tool | Arguments | What it does |
| --- | --- | --- |
| `ai_usage` | `provider?` | Read usage for the current workspace's session. Defaults to the invoking provider. |
| `timer_set` | `seconds`, `prompt`, `idempotency_key?` | Schedule a continuation in 1–604800 whole seconds (up to seven days). |
| `timer_set_at` | `due_at`, `prompt`, `idempotency_key?` | Schedule a continuation at a future ISO-8601 timestamp, up to seven days ahead. |
| `model_switch_next` | `model`, `reasoning` | Queue a validated model/reasoning choice for one new turn and queue its continuation. |
| `session_new` | `prompt` | After this turn, archive the conversation and send a handoff prompt to a fresh session in the same workspace/provider. |

Timer and handoff prompts are limited to 10,000 characters. Timers and session
controls target the invoking agent; task tools address another task explicitly.

### Workflow tools

The workflow server advertises different tools for two kinds of block. Typed **AI
Agent** blocks get the connection tools below plus the task/session tools above.
Other workflow agent blocks get the stack, recovery, and feature-plan tools instead.
Outside an active workflow, workflow calls are unavailable even if their names
appear in the server's tool list.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `workflow_connections` | None | List outgoing blocks, their IDs, descriptions, and `use`, `follow`, or named `path` connections. |
| `workflow_use_block` | `block_id`, `input` | Invoke a block connected by `use` and return its output. AI blocks continue their existing context. Timer blocks arm their configured countdown and return immediately; their `follow` connections receive the input when they fire. |
| `workflow_choose_path` | `path` | Select a connected path by label. It receives the caller's final output after the turn finishes; `follow` connections also run. |
| `workflow_run_stack` | `inputs`, `path?`, `idempotency_key?` | Run directly connected downstream agents and wait for their results within the caller's turn. `inputs` is a nonempty list of prompts; `path` is required for AI-selected routing. |
| `workflow_resume_failed` | None | Queue failed blocks for continuation in their existing sessions. Returns immediately and leaves running/completed blocks alone. |
| `workflow_plan_features` | `features` | Save the complete feature plan before implementation tasks are created. Each feature has `id`, `prompt`, and optional `prerequisites` (feature IDs). |

Feature IDs must be unique. Prerequisites must refer to other planned features and
cannot form a cycle. Once saved, the plan cannot be replaced mid-run; repeating the
same plan is allowed. Pass `feature_id` when starting its task so Core can enforce
that prerequisites have merged. Merging the assigned task completes the feature and
returns newly ready features.

Tools with `idempotency_key` can identify a workflow operation across retries. Use a
stable key for one intended operation and reuse it only to retry that operation; a
different operation needs a different key. Workflow startup failures can preserve
the created task and return recovery instructions. Inspect that task before creating
a replacement.

## Choose the agent for a new task

An **agent** is a Vibe Editor instruction preset. `provider` selects the Codex or
Copilot backend, `model` selects its model, and `agent` selects the Markdown preset
whose instructions and MCP allowlist are attached to the new session.

Agent presets are Markdown files with optional YAML frontmatter. Create and edit
global or repository-local presets in the Desktop **Agents** panel; repository-local
presets are stored outside the checkout in Core's workspace state. A repository may
also commit workspace presets under `.agents/*.md`. The scope names used by MCP are:

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

Add `vibe-editor` under `mcpServers` when the started task should itself receive the
built-in Vibe Editor MCP tools. An empty or omitted `mcpServers` list gives the
preset no built-in task tools.

`task_create_and_start` accepts `agent` as either a precise `{ "scope", "name" }`
file reference or JSON `null`:

- omit `agent` to inherit the invoking AI session's selected preset, if it has one;
- pass a reference to choose a configured preset explicitly;
- pass `"agent": null` to suppress inherited preset instructions and start only the requested provider/model session.

An empty string is not a no-agent value. References use the file name, including
`.md`, rather than the preset's frontmatter display name. Missing or changed presets
are rejected before a task worktree is created.

`reasoning` is also optional. When omitted, normal provider/model default selection
is preserved. An explicit value overrides that default and must occur in the
selected model's advertised `reasoningLevels`; supported values are model- and
provider-specific and may include values such as `none`, `low`, `medium`, `high`,
`xhigh`, or `max`. Models that advertise no reasoning levels require the field to be
omitted. Explicit reasoning is validated against the model catalogue before task
creation.

For example, after confirming the provider advertises this model and reasoning
level, create a task with a configured preset:

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

Existing callers that send only `prompt`, `provider`, and `model` remain valid.
There is currently no separate MCP tool for starting an existing idle task:
`task_append_prompt` steers a running task or starts a follow-up turn with that
task's persisted session configuration, so it does not accept a new `agent` or
`reasoning` selection.

## Understand usage and continuations

Call `ai_usage` to inspect the invoking provider's current session. The result
contains `used`, `limit`, computed `remaining`, `unit`, and `resets_at`; unavailable
values are returned as `null`. `kind: "context_window"` means those top-level
numbers describe conversation capacity. When available, `account_quota` separately
reports the plan plus primary and secondary rolling windows, including
used/remaining percentages and reset times. Codex retrieves this snapshot from its
authenticated app-server `account/rateLimits/read` endpoint; other ACP providers may
leave it `null`.

`timer_set` and `timer_set_at` schedule one continuation for the current task and
provider. Use a delay with `timer_set`, or pass a quota reset timestamp as `due_at`
to `timer_set_at`. Setting either timer replaces the existing timer for that
task/provider. Timers are persisted by Core and recovered after restart. Once the
current turn finishes, task summaries report `status: "waiting"` and `waitingUntil`
until Core sends the continuation prompt. Deleting a task cancels its timers.

`model_switch_next` queues a one-shot `model` and `reasoning` override for the
invoking provider session. Both values are required and validated together against
the provider's current model catalogue. It never changes the turn that calls it;
when called during a running turn, it automatically queues a continuation, and that
newly started turn consumes the override, replacing UI/default configuration for
that turn only. Calling the tool again before consumption replaces the pending
override. Generated assistant messages record their effective model so later
configuration changes do not rewrite response provenance.

`session_new` deliberately refreshes the invoking agent's context without creating a
task or worktree. It accepts a self-contained `prompt`, waits for the MCP-calling
turn to finish, archives the old conversation, creates a context-empty session in
the same workspace and provider with the same configuration and selected agent
preset, and sends the handoff prompt as that session's first message. Requesting a
fresh session supersedes ordinary queued follow-ups.
