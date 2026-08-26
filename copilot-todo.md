# Copilot ACP parity review

Reviewed against the installed **GitHub Copilot CLI 1.0.80** and GitHub's current Copilot CLI/ACP documentation.

The implementation preserves the basic Copilot coding loop, but it is not a replacement for the Copilot CLI yet. The most important losses are resumable session context, permission control, native attachments, reliable model configuration, authentication, and most of the Copilot-specific management surface.

## Important gaps

| Priority | Gap | Practical impact |
| --- | --- | --- |
| Critical | No real session resume | The transcript is saved locally, but restarting VibeEditor or changing a setting starts a new Copilot session without the previous model context. |
| Critical | Permission requests are silently approved | Tool, write, path, URL, and MCP permission prompts select `allow_once` automatically; the user cannot inspect or reject an action. |
| High | Model and reasoning selection are not reliable | The provider does not pass `--model` or reasoning at launch and assumes suitable dynamic config options will be present. Copilot can publish some options only after session creation. |
| High | Images and embedded context are reduced to text | Copilot advertises native image and embedded-context support, but Vibe sends one text block and reads every uploaded file with `file.text()`. |
| High | Copilot-specific safety controls are absent | Tool availability, explicit allow/deny rules, URL/path rules, sandboxing, secret redaction, temporary-directory access, and autonomous-run limits are not configurable in Vibe. |
| High | Authentication is not implemented | ACP advertises a terminal login method, but the client never invokes it. A prior `copilot login` or BYOK environment is required. |
| Medium | Available ACP commands are discarded | Copilot advertises a large, current command list after session creation, but the client ignores `available_commands_update`. |
| Medium | Native custom agents are not selected | Vibe's “agent” is only instructions prepended to the prompt; it does not use Copilot's `--agent` or native agent definitions and ignores `agent.mcpServers`. |
| Medium | Per-session MCP supports only stdio | The contract cannot describe HTTP/SSE MCP servers, headers, URLs, OAuth, tool filters, or timeouts even though Copilot ACP advertises HTTP and SSE support. |
| Medium | Structured quota information is absent | Vibe shows context/latest-turn tokens when reported, but not Copilot AI credits, plan limits, or the richer `/usage` breakdown. |
| Medium | ACP version compatibility is unchecked | Copilot ACP is public preview, the executable is an unpinned external binary, and the provider performs no minimum-version or capability validation. |
| Medium | ACP tests are currently red | 7 of the 13 shared ACP integration tests fail with `ACP connection closed`. There is no authenticated Copilot ACP integration test. |

## 1. Persisted transcript is not a resumed Copilot session

The live Copilot 1.0.80 handshake advertises:

- `loadSession: true`
- session listing
- session closing

The client does not use any of them. `StdioAcpProvider.connect()` always calls `newSession`, then overwrites the locally stored `threadId`. Configuration changes call `closeRuntime()`, so changing a model, reasoning level, mode, or credit cap also abandons the live context.

The visible transcript can therefore disagree with what Copilot remembers. A later instruction such as “implement the plan above” may be interpreted without the plan actually being in model context.

### Required work

1. [ ] Inspect `agentCapabilities.loadSession` and session capabilities during initialization.
2. [ ] Call ACP load/resume with the persisted session ID when reopening a workspace.
3. [ ] Reconstruct the visible transcript from the authoritative loaded ACP history where available.
4. [ ] Expose session list, new, rename, close, and resume operations in the UI.
5. [ ] Do not restart the session for options that ACP can change in place.

## 2. Permission handling removes Copilot's main safety boundary

The common ACP client handles every permission request by selecting the first `allow_once` option, falling back to `allow_always`. No request details or decision UI are shown.

This applies to the actions for which Copilot normally asks explicit permission, including writes, potentially destructive shell commands, paths outside the workspace, URLs, and MCP tools. GitHub documents allow-once, session, and persisted approval choices, with deny rules taking precedence. See [Allowing and denying tool use](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

The Copilot session can report `allow_all = off` while Vibe still approves each request automatically. That makes the displayed state misleading.

### Required work

1. [ ] Add a blocking permission card showing tool name, command/path/URL, affected scope, and every ACP response option.
2. [ ] Require an explicit user choice for approval or rejection.
3. [ ] Distinguish allow-once, allow-for-session, and persisted approval semantics.
4. [ ] Add launch-time tool availability plus allow/deny rules.
5. [ ] Add URL, path, sandbox, and temporary-directory controls.
6. [ ] Add an obvious full-access warning for `allow_all` and autopilot.

## 3. Model and reasoning configuration can diverge from the UI

`CopilotSessionManager.command()` launches only:

```text
copilot --acp --stdio [--max-ai-credits=N]
```

It does not pass `--model`, `--reasoning-effort`, `--context`, or reasoning-summary settings.

The common provider later tries to apply model and reasoning only if matching ACP config options are present in the immediate `session/new` result. In a live Copilot 1.0.80 BYOK handshake:

- `session/new` initially returned mode and `allow_all`.
- `reasoning_effort` arrived in a later `config_option_update`.
- The model was fixed by the BYOK environment and no model option was returned.

This means a stored reasoning choice may miss the initial application window and be replaced by Copilot's default. The model picker can also display fallback GitHub-hosted models that are not usable for a BYOK server.

GitHub notes that some ACP settings are server-launch settings and are inherited by sessions. See the [Copilot CLI ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).

### Required work

1. [ ] Wait for authoritative model/reasoning configuration before applying stored choices.
2. [ ] Treat later `config_option_update` messages as initialization state, then apply the user's desired value once the option appears.
3. [ ] Pass server-scoped configuration at process launch where required.
4. [ ] Do not show the hardcoded fallback catalogue when BYOK fixes the server to a different model.
5. [ ] Confirm the applied model and effort from Copilot's response and warn when they cannot be changed.
6. [ ] Add tests for GitHub-hosted and BYOK initialization sequences.

## 4. Native attachments and rich ACP content are unused

The live agent advertises:

- image prompts
- embedded context
- no audio prompts

Vibe's provider request contains only a string. Desktop attachments are concatenated into Markdown, and uploaded files are always read through `file.text()`.

Consequences:

- Screenshots and diagrams are not vision inputs.
- PDF, office, archive, and other binary/native documents are corrupted or converted to meaningless text.
- Large text files consume prompt tokens unnecessarily.
- ACP resource links and embedded resources are unavailable.
- Workspace paths are only mentioned in text rather than attached with typed context.

Copilot CLI supports native `--attachment` input, subject to model and organization vision policy. See the [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

### Required work

1. [ ] Change the request contract from one string to ACP content blocks.
2. [ ] Send supported images as ACP image blocks.
3. [ ] Send text files as embedded resources with URI and MIME type.
4. [ ] Reject unsupported binary files with a clear message instead of calling `file.text()`.
5. [ ] Render image and resource output from tool calls.

## 5. Copilot's dynamic command surface is available but invisible

Copilot ACP sends `available_commands_update` after a session is created or loaded and again when skills finish loading. GitHub calls this list the authoritative command set and recommends that ACP clients surface it in a command menu. The current update switch ignores it.

The live 1.0.80 server advertised commands including:

- `/permissions`, `/allow-all`, and `/reset-allowed-tools`
- `/compact`, `/context`, `/usage`, and `/session`
- `/model`, `/plan`, and `/autopilot`
- `/review`, `/security-review`, and `/research`
- `/mcp`, `/skills`, `/plugin`, and `/env`
- `/fleet`, `/memory`, `/remote`, `/sandbox`, `/share`, and scheduling commands

These can generally be typed manually as ordinary prompts, but users receive no discovery, argument hints, validation, or completion. Skills that appear later are also invisible.

GitHub documents both the supported ACP commands and terminal-only exclusions in the [ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). Terminal UI commands such as `/diff`, `/resume`, `/theme`, `/settings`, `/login`, `/help`, `/tasks`, and `/undo` do not run over ACP and require native Vibe equivalents if parity is desired.

### Required work

1. [ ] Store each complete `available_commands_update` snapshot on the session.
2. [ ] Add slash completion and a searchable command menu.
3. [ ] Display each command's description and argument hint.
4. [ ] Add native UI equivalents for session resume, diff review, login, tasks, and undo/rewind.
5. [ ] Prevent known terminal-only commands from being accidentally forwarded to the model as prose.

## 6. Authentication requires prior CLI setup

Copilot 1.0.80 advertises an ACP authentication method containing the exact terminal command needed to run `copilot login`. The client records only a human-readable hint and never performs ACP authentication or terminal-auth handling.

The result is acceptable for a developer who already authenticated externally, but poor for first-run onboarding and expired credentials. BYOK works only when the necessary `COPILOT_PROVIDER_*` environment is already supplied to Vibe.

### Required work

1. [ ] Detect and render advertised ACP authentication methods.
2. [ ] Run terminal authentication in a visible, user-controlled integrated terminal.
3. [ ] Retry session creation after successful login.
4. [ ] Surface organization-policy and entitlement failures separately from missing authentication.
5. [ ] Document BYOK environment propagation and secret handling.

## 7. Custom-agent support is prompt composition, not Copilot agents

The provider reports `agents: true`, but `request.agent` only prepends its instructions to the user prompt. It does not:

- launch Copilot with `--agent=<id>`
- select a native `.agent.md` definition
- honor the agent's model or tool configuration
- enforce `agent.mcpServers`
- isolate instructions from ordinary user text

Copilot CLI supports native custom agents and built-in specialist agents. See the custom-agent section of the [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

### Required work

1. [ ] Rename the current feature to “prompt preset” until native behavior exists, or stop advertising `agents: true`.
2. [ ] Discover native Copilot agents and their metadata.
3. [ ] Start the ACP server/session with the selected native agent when supported.
4. [ ] Enforce the selected agent's MCP and tool restrictions.
5. [ ] Keep application instructions structurally separate from the user prompt.

## 8. MCP support omits remote transports and policy

The live handshake advertises HTTP and SSE MCP support. Vibe's `AiMcpServer` can describe only a command, arguments, and environment variables, and the adapter always creates an ACP stdio server record.

Missing per-session capabilities include:

- HTTP and SSE URLs
- authentication headers and OAuth
- tool filters
- startup/tool timeouts
- enabled/disabled server management
- server-instruction allowlisting
- built-in GitHub MCP tool/toolset controls

Persistent MCP servers configured in Copilot CLI may still load normally, but Vibe cannot fully configure or inspect them. See GitHub's [MCP configuration reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#mcp-server-configuration).

### Required work

1. [ ] Extend `AiMcpServer` with stdio, HTTP, and SSE variants.
2. [ ] Add URL/header/OAuth and timeout fields with secure secret storage.
3. [ ] Add enabled-tool and disabled-tool filters.
4. [ ] Surface MCP startup/authentication errors and server status.
5. [ ] Decide how persistent Copilot MCP configuration and Vibe session overrides should merge.

## 9. Copilot-specific operational features remain CLI-only

The following may matter depending on workflow and are not exposed as first-class Vibe features:

- AI-credit quota and detailed `/usage`
- context-source breakdown
- context tiers
- plan approval and autonomous continuation limits
- fleet/subagent task management
- session fork, rewind, rename, share, and remote control
- diff commenting and change rollback
- GitHub issue/PR/gist browsing
- plugin, skill, hook, LSP, extension, and memory management
- repository trust controls
- OpenTelemetry monitoring and diagnostics
- voice input, themes, terminal shortcuts, and screen-reader-specific UI

Not all terminal UI features belong in Vibe, but session continuity, usage, task management, undo/rewind, diff review, and trust/permissions are likely worth implementing.

## What is retained

Routine work should function while the ACP process and session remain alive:

- Copilot's native ACP server rather than a prompt-mode wrapper
- Basic conversational turns
- Shell commands, file reads/edits, search, and Copilot tools
- Streamed assistant messages, reasoning summaries, plans, and tool activity when emitted in the handled forms
- Plan and autopilot modes advertised dynamically
- Cancellation
- Queued follow-up turns when Copilot does not advertise live steering
- Context-window and latest-turn token reporting when emitted
- Persistent Copilot instructions, configured skills/plugins, and configured MCP servers loaded by the CLI
- Built-in Copilot subagents and GitHub tooling available to the underlying agent
- Per-server `--max-ai-credits` launch guard
- BYOK operation when the provider environment is already configured

## Compatibility and maintenance risk

GitHub marks Copilot ACP support as **public preview and subject to change**. Vibe launches whichever `copilot` executable is first in `PATH`, optionally overridden by `COPILOT_CLI_PATH`, but it does not:

- require or validate a minimum version
- pin a known compatible CLI build
- branch on advertised capabilities
- report the connected CLI version in the UI
- run a real Copilot ACP compatibility test

The hardcoded fallback model list will also drift as GitHub changes model availability, pricing, reasoning support, and organization policy.

### Required work

1. [ ] Display the detected Copilot CLI path and version.
2. [ ] Enforce a documented minimum supported version.
3. [ ] Prefer capability detection over version checks for optional ACP behavior.
4. [ ] Clearly label fallback model data and never present it as authoritative account availability.
5. [ ] Add a lightweight BYOK ACP handshake test that requires no GitHub login or model request.
6. [ ] Add an optional authenticated end-to-end test for session creation, model discovery, permissions, resume, attachments, and `/usage`.

## Verification result

- Installed executable: **GitHub Copilot CLI 1.0.80**.
- Live read-only handshake verified ACP protocol version 1 and the capabilities described above.
- Live BYOK session creation was tested against a non-routable local endpoint; no model request was made.
- TypeScript typechecking passes across all workspaces.
- Shared ACP integration tests: **6 passed, 7 failed**.
- `docs/ACP.md` is stale: it says Copilot exposes context tier, agent mode, and reasoning summaries as provider options, while the current descriptor exposes only `maxAiCredits`. Dynamic ACP mode options do appear after connection, but the documented static settings do not match the code.

## Recommended implementation order

1. [ ] Implement ACP session resume/load and stop resetting context on settings changes.
2. [ ] Replace automatic approval with a real permission decision UI.
3. [ ] Make model and reasoning application authoritative and race-safe.
4. [ ] Support native ACP image/resource content blocks.
5. [ ] Capture and render available commands, usage, and session state.
6. [ ] Implement terminal authentication onboarding.
7. [ ] Add Copilot-specific safety and launch controls.
8. [ ] Support native custom agents rather than prompt prepending.
9. [ ] Add HTTP/SSE MCP configuration and secure authentication fields.
10. [ ] Repair the shared ACP tests and add real Copilot compatibility coverage.

Until these are complete, use Vibe's Copilot ACP integration for bounded tasks in one uninterrupted session. Keep the Copilot CLI available for permission-sensitive work, long conversations, login, session management, native attachments, diff/undo workflows, quota inspection, agents/plugins/MCP management, and advanced autonomous execution.
