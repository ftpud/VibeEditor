# Repository guide

Vibe Editor is a Node 20+ npm-workspaces monorepo. The remote Core owns files, processes, and durable workspace state; the local Electron clients own interaction. Prefer source under `packages/*/src`; do not infer behavior from compiled output.

## Package map

- `packages/acp/src/index.ts` — provider-neutral AI types, configuration helpers, and the abstract `AcpProvider` contract.
- `packages/protocol/src/index.ts` — shared Core/Desktop WebSocket operations, DTOs, errors, and server events; it re-exports ACP types.
- `packages/core/src/index.ts` — Core CLI entry point. `server.ts` composes the WebSocket API and workspace-scoped services; sibling modules implement filesystem, search, Git, terminals, tasks/state, HTTP, and Java/JDT LS.
- `packages/core/src/ai/` — ACP registry/transport; built-in Codex and Copilot adapters are in `ai/providers/`. See `docs/ACP.md` before changing provider behavior.
- `packages/desktop/src/renderer/` — React/Monaco UI. Start at `main.tsx`, `App.tsx`, and the typed WebSocket `client.ts`; feature panels and colocated UI tests live here.
- `packages/desktop/src/electron/` — Desktop Electron main process, preload bridge, and settings persistence.
- `packages/gateway/src/renderer/` and `packages/gateway/src/electron/` — Gateway UI and Electron SSH provisioning/tunneling/client-launch logic. Gateway does not import the other workspaces; it deploys Core and transfers built Desktop artifacts.
- `scripts/` — repository-wide Electron launch/runtime, postinstall, node-pty, and optional JDT LS/JRE setup helpers. Package-local dev launchers are in `packages/{desktop,gateway}/scripts/`.
- `docs/`, `README.md`, `WHY.md`, `FEATURES.md` — architecture, operation, and product context.

Dependency direction is `acp -> protocol -> core/desktop`; Core and Desktop also use ACP directly. Runtime traffic is Desktop -> typed WebSocket protocol -> Core services. Gateway sits outside that import graph and manages a remote Core plus a local Desktop build. When changing an operation, update protocol types/registry first, then Core routing and Desktop callers; build ACP and Protocol before checking consumers.

## Commands

Run from the repository root after `npm install`:

```bash
npm run build                 # all five workspaces, dependency order
npm run typecheck             # builds ACP/Protocol; checks Core/Desktop
npm run typecheck -w @remote-ide/gateway
npm test                      # all workspaces with tests (Core and Desktop)
```

Targeted checks use `npm run {build|typecheck|test} -w @remote-ide/<package>` where that script exists. Common development entry points are `npm run dev:core -- --workspace /absolute/path`, `npm run dev:desktop`, and `npm run dev:gateway`; see `README.md` for host/port and remote-launch details.

## Navigation and editing

- Use `rg '<request-or-event-name>' packages/protocol/src/index.ts packages/core/src/server.ts packages/desktop/src/renderer` to trace an end-to-end feature.
- For Electron IPC, search the channel string across a package's `src/electron`, renderer `global.d.ts`, and renderer callers.
- Tests are colocated as `*.test.ts`/`*.test.tsx`; Core provider fixtures also include `packages/core/src/ai/providers/fake-acp-agent.{mjs,py}`.
- Keep platform-neutral contracts in ACP/Protocol and provider-specific behavior under Core's provider adapters. Do not add provider-id branches to shared protocol or UI when descriptor metadata can drive behavior.
- Preserve the server-owned-state boundary: Desktop should request operations rather than access workspace state locally.

Generated or installed directories are ignored and must not be hand-edited: `node_modules/`, `coverage/`, `packages/*/dist/`, `packages/*/dist-electron/`, `packages/*/dist-renderer/`, `.tools/`, and `.electron-runtime/`. Regenerate them through package builds or the install scripts. Do not commit secrets from `.env*` or provider/MCP configuration.
