# AI Capability Provider layer

The core talks to AI tools only through `AcpProvider` and `AcpRegistry` in `packages/core/src/ai/acp.ts`. Provider adapters live under `packages/core/src/ai/providers/`. Codex and Copilot are plugins registered at server startup; request routing and the desktop UI do not branch on their ids.

## Provider contract

An ACP plugin supplies:

- a stable id, display name, capability flags, and provider-defined option schema;
- model discovery, resumable session persistence, configuration, typed-content send, permission resolution, clear, and optional usage operations;
- translation of the common MCP server and custom-agent structures to its native CLI/API.

To add a provider, subclass `AcpProvider`, implement the six operations under `ai/providers`, and register one instance in `ai/index.ts`. `AiProvider` is an open string, and the desktop builds its provider selector and extra controls from `ai.providers`, so no protocol or UI enum needs editing.

## Current adapters

Codex discovers model and reasoning metadata from its local model cache, which also supplies context window sizes, input modalities, and retirement notices for the models advertised over ACP. Its ACP options expose sandbox and web search. Saved session ids are loaded when the agent advertises `loadSession`; loaded history replaces the local transcript. MCP definitions are supplied during session setup and selected custom-agent presets can restrict the enabled MCP set.

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
