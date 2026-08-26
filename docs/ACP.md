# AI Capability Provider layer

The core talks to AI tools only through `AcpProvider` and `AcpRegistry` in `packages/core/src/ai/acp.ts`. Provider adapters live under `packages/core/src/ai/providers/`. Codex and Copilot are plugins registered at server startup; request routing and the desktop UI do not branch on their ids.

## Provider contract

An ACP plugin supplies:

- a stable id, display name, capability flags, and provider-defined option schema;
- model discovery, session persistence, configuration, send, clear, and optional usage operations;
- translation of the common MCP server and custom-agent structures to its native CLI/API.

To add a provider, subclass `AcpProvider`, implement the six operations under `ai/providers`, and register one instance in `ai/index.ts`. `AiProvider` is an open string, and the desktop builds its provider selector and extra controls from `ai.providers`, so no protocol or UI enum needs editing.

## Current adapters

Codex discovers model and reasoning metadata from its local model cache. Its ACP options expose sandbox and web search. MCP definitions become per-invocation `mcp_servers.*` config overrides; custom-agent instructions are prepended to the task. The Codex CLI does not currently expose account quota through the non-interactive interface, so ACP reports usage as unsupported instead of inventing a value.

Copilot discovers models from CLI completion metadata. Its ACP options expose context tier, agent mode, a per-session AI-credit ceiling, and reasoning summaries. MCP definitions use `--additional-mcp-config`; user-defined agent instructions are composed into the prompt and can restrict the enabled MCP set. Copilot documents quota details in interactive `/usage`; ACP reports that availability and exposes the credit ceiling, but the CLI does not currently provide a stable machine-readable quota command.

## Common request extensions

`ai.send` accepts optional `mcpServers` and `agent` fields. MCP environment values may contain secrets, so callers should retrieve them from secure local storage and must not persist them in workspace settings. Provider options live in the session's `configuration` map and are rendered from the option schema.

The layer is named ACP inside this application as an AI Capability Provider abstraction. It can later be backed by the external Agent Client Protocol without changing consumers; Copilot's native `--acp` mode is a candidate transport adapter rather than the application contract itself.
