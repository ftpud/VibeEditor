# Codex ACP parity review

The ACP implementation preserves the core Codex coding loop, but it is not yet functionally equivalent to Codex CLI. The biggest risks are conversation continuity and permission handling—not model quality.

## Important gaps

| Priority | Gap | Practical impact |
| --- | --- | --- |
| Critical | No real session resume | Conversations appear persisted, but after restart or any settings change, Codex starts a new thread without the previous model context. |
| Critical | Permissions are automatically approved | Every `allow_once` request is accepted without showing the user what is being authorized. You cannot reject or inspect escalation requests. |
| High | Settings changes destroy context | Changing model, reasoning, sandbox, web search, or other configuration closes the runtime and the next message starts a new thread. |
| High | Attachments are text-only | Images, binary files, resource links, and native ACP embedded context are not sent in their supported forms. |
| High | Authentication and MCP elicitation are missing | Existing Codex login works, but the app cannot perform ChatGPT login, API-key setup, device flow, MCP OAuth, or structured MCP questions. |
| Medium | Most CLI commands are absent | No session picker, fork, diff view, usage view, plugin browser, hooks UI, memories, personality, background-process control, or `/mention`. |
| Medium | ACP events are discarded | Available commands, goal state, session titles, rich image output, terminal metadata, and some provider/rate-limit state never reach the UI. |
| Medium | Account quota is absent | You only see latest-turn tokens/context—not the daily or weekly account limits available through CLI `/usage`. |
| Medium | Test coverage is currently red | 7 of the 13 ACP integration tests fail with `ACP connection closed`. |

## 1. Persisted chat is not persisted Codex context

The application saves `threadId`, but reconnect always calls `newSession`; it never calls ACP `loadSession` or resume:

- A new session is unconditionally created in `packages/core/src/ai/stdio-provider.ts`.
- The resulting thread ID is merely overwritten into local state.
- Configuration closes the current runtime.

Consequently, after restarting VibeEditor—or changing a setting—the transcript is still visible, but Codex has forgotten it. This can produce dangerously misleading follow-ups like “implement the plan above.”

Codex's native app-server explicitly supports starting, resuming, and forking threads, and the SDK supports resuming from a thread ID. See the [official app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk).

This is the first thing to fix.

## 2. Approval requests bypass the user

The client chooses `allow_once` automatically in `packages/core/src/ai/stdio-provider.ts`.

That loses an essential Codex CLI safety boundary. In workspace-agent mode, attempts to access outside the workspace, use restricted network access, or perform other escalated actions can be accepted without the user seeing the command or consequences. It also removes the ability to reject a suspicious MCP action.

The CLI deliberately exposes approval policy and permission controls because sandboxing and approval are separate layers. See the [official approval and security documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

Until fixed, treat “Workspace agent” as more permissive than its label suggests.

## 3. Native images and rich context are unused

The installed `codex-acp` supports text, images, embedded resources, resource links, and additional workspace directories. The application contract only accepts a string prompt, and the desktop turns attachments into Markdown text.

Therefore:

- Screenshots are not vision inputs.
- Non-text files are mishandled by `file.text()`.
- Large files consume prompt tokens instead of being referenced appropriately.
- Files outside the workspace cannot be added as scoped writable directories.
- Generated or viewed images are likely reduced to incomplete tool activity.

This matters for UI debugging, diagrams, screenshots, design work, and repositories with multiple roots.

## 4. The adapter exposes more than the client consumes

`codex-acp` 1.6.2 bundles Codex CLI 0.148.0 and supports configuration, tool events, subagents, goals, reviews, compaction, skills, MCP, image operations, and session loading. The event switch only handles basic messages, thoughts, tools, plans, config, usage, and compaction; everything else reaches the default branch and disappears.

Typing these manually should work through the adapter:

- `/plan`
- `/mcp`
- `/skills`
- `/status`
- `/review`
- `/review-branch`
- `/review-commit`
- `/compact`
- `/goal`
- `/logout`
- Installed `$skill-name` commands

However, `available_commands_update` is ignored, so there is no discovery or completion. Goal and session-info updates are ignored too. By comparison, the CLI exposes a much larger interactive command set including permissions, models, fast mode, fork/resume, plugins, hooks, diff, usage, memories, side chats, background processes, and session management. See the [official CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## 5. Authentication assumes Codex is already configured

The handshake reads advertised authentication methods, but the client never calls ACP authentication and advertises no elicitation capabilities.

Normal operation therefore depends on a prior CLI login or environment-provided API key. MCP servers requiring OAuth or interactive structured input can also fail. Retain the CLI for:

- `codex login`
- `codex mcp login`
- MCP troubleshooting
- Plugin installation and marketplace management
- `codex doctor`

## 6. MCP and custom-agent support are overstated

The descriptor declares `mcp: true` and `agents: true`, but:

- MCP servers apply only when the runtime is first created; subsequent server lists are ignored because the existing runtime is reused.
- Custom-agent instructions are simply prepended to the prompt.
- `agent.mcpServers`, despite existing in the contract, is never enforced.

This is not equivalent to isolated custom agents with restricted tool sets. Native Codex subagents can still operate internally, but the application-level “agent” abstraction is mostly prompt composition.

## What is retained

Routine Codex tasks should otherwise work well while the process remains alive:

- Current bundled Codex model execution
- Model and reasoning selection
- Fast mode when dynamically advertised
- Read-only, workspace, and full-access modes
- Live, indexed, cached, or disabled web search
- Local `config.toml`, `AGENTS.md`, skills, and configured MCP servers
- Shell execution and file edits
- Reasoning, tool, diff, plan, and usage streaming
- Mid-turn steering
- Cancellation
- Context-window and latest-turn token reporting
- Underlying Codex subagent execution, displayed as tool activity

## Verification result

- TypeScript typechecking passes across all workspaces.
- ACP integration tests: **6 passed, 7 failed**. All live fake-agent transport tests currently fail with `ACP connection closed`; model fallback masks one of those failures.
- `docs/ACP.md` is stale: it says this layer may later use external ACP, although `StdioAcpProvider` already is a real ACP transport. It also understates the current token-usage support.

## Recommendation

The current implementation is suitable for self-contained tasks completed in one uninterrupted session. Keep Codex CLI available for long-running conversations, security-sensitive work, image-heavy tasks, authentication and MCP setup, session branching or resumption, quota inspection, and plugin management.

Before considering ACP a CLI replacement, implement these items in order:

1. [x] Use ACP `loadSession` or resume with the saved `threadId`.
2. [x] Apply configuration in place without terminating the thread.
3. [x] Add a permission-review UI with allow and reject choices.
4. [x] Support native ACP content blocks and image attachments.
5. [ ] Add authentication and elicitation handlers.
6. [ ] Surface command discovery, goals, account limits, and richer events.
7. [ ] Add session list, fork, archive, and delete controls.
8. [x] Repair and extend the failing ACP transport tests.
