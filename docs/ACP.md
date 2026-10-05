# ACP: the AI provider abstraction

Vibe Editor uses one interface for Codex and GitHub Copilot. Core handles each
provider through `AcpProvider`; Desktop reads the provider's capabilities and
settings to build the AI controls. Adding a provider should not require special
cases in the UI or shared protocol.

Here, **ACP** names Vibe's AI Capability Provider layer. The Codex and Copilot
adapters communicate with their agents over **Agent Client Protocol**, also
abbreviated ACP. The abstraction and the wire protocol have different roles.

For tools that agents can use to manage Vibe tasks, timers, sessions, and workflows,
see [MCP tools](MCP.md).

## How the pieces fit together

- `packages/acp/src/index.ts` defines `AcpProvider` and the shared data types.
- `packages/core/src/ai/acp.ts` registers providers and looks them up by ID.
- `packages/core/src/ai/providers/` contains the provider-specific adapters.
- `packages/core/src/ai/index.ts` registers Codex and Copilot at startup.

Desktop sends typed requests to Core. Core selects the registered provider, and its
adapter translates the common request into the agent's native format. Provider IDs
are open strings; capabilities and option metadata describe what the UI can offer.

## What a provider supplies

Each provider declares its ID, display name, capabilities, and settings schema. It
implements model discovery, session configuration, sending and steering prompts,
interruption, permission decisions, and conversation history. Sessions can be
listed, restored, cleared, or removed. Usage reporting is optional.

Common requests support text, base64 images, embedded text resources, and resource
links. They can also carry MCP server definitions and custom-agent instructions.
Adapters translate those definitions for their own backend. Provider settings live
in the session's `configuration` map.

`StdioAcpProvider` implements Agent Client Protocol v1 over newline-delimited JSON.
It handles permission prompts through `ai.permission.resolve`, slash command
snapshots, rich output, saved-session loading, and dynamic settings. Session-scoped
settings apply without restarting the agent. Launch-scoped changes restart it and
resume the saved session when supported.

## Codex

The Codex adapter supplements the agent's model list with its local model cache.
That cache provides context-window sizes, accepted input types, reasoning
descriptions, and retirement notices. The settings expose sandbox and web-search
choices. When the agent supports `loadSession`, restoring a saved session loads its
history in place of the local transcript.

The Codex ACP release can lag behind the Codex CLI. The root npm override pins its
bundled CLI to a version that can run GPT-6 Sol, even when the ACP model catalogue
has not advertised it yet.

### Managed runtime updates

Before accepting connections, Core checks npm's latest versions of
`@agentclientprotocol/codex-acp` and `@openai/codex`. It installs updates in a new
directory under `~/.remote-ide/codex-runtime` and selects that installation only
after it succeeds. This does not change the repository dependencies or lockfile. ACP
sessions and account-quota reads use the selected runtime.

Registry fetches have a 15-second timeout; each npm command has a 60-second limit.
If an update fails or the host is offline, Core logs a warning and keeps the
previous cached runtime, falling back to the bundled dependency on first startup. An
updated runtime can resolve stale model catalogues, but model access still depends
on the account and the agent's advertised capabilities.

| Setting | Effect |
| --- | --- |
| `REMOTE_IDE_CODEX_AUTO_UPDATE=0` | Skip startup runtime updates. |
| `REMOTE_IDE_CODEX_RUNTIME_DIR` | Store the runtime cache elsewhere. |
| `CODEX_PATH` | Override the Codex binary used for ACP sessions. |

## GitHub Copilot

The Copilot adapter discovers models from the agent's configuration metadata. When
published in the model option's `_meta`, it includes premium-request multipliers,
cost tiers, and availability. Saved model and reasoning choices are supplied at
launch and applied again when dynamic options arrive.

Sessions can have an AI-credit ceiling. Copilot exposes detailed quota information
through its interactive `/usage` command; Vibe's shared usage view shows the context
and latest-turn token data reported over ACP.

## Model and usage metadata

Models always have an ID and name in the common catalogue, along with their
reasoning choices. Optional `AiModel` fields describe cost, availability, context-
window limits, accepted input types, reasoning levels, and deprecation notes.
Providers fill in what they can discover; Desktop displays the fields that are
present. A context window reported only in a turn's `usage_update` is recorded
against the selected model when observed. Adapters can supplement handshake metadata
by overriding `describeModels`.

Conversation capacity and account quota are separate. Codex can read account quota
from its authenticated app-server `account/rateLimits/read` endpoint; other
providers may omit it. Missing usage data should be treated as unknown.

## Adding a provider

Implement an `AcpProvider` under Core's `ai/providers/` directory and register it in
`ai/index.ts`. Use the shared session, model, content, failure, MCP, and agent
types. Keep backend-specific translation in the adapter and expose settings through
descriptor metadata instead of adding provider-ID branches to the protocol or UI.

MCP definitions support stdio, HTTP, and SSE transports. Environment variables and
headers can contain secrets; retrieve those from secure storage rather than
persisting them in workspace settings. Internal Vibe MCP operations are documented
separately in [MCP.md](MCP.md).
