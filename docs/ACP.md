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
