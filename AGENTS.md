# Vibe Editor repository guide

Node 20+ npm-workspaces monorepo. Core runs remotely and owns workspace files,
processes, and durable state; Electron clients own interaction. Read and change
`packages/*/src`, never generated output.

## Route by change

| Change | Start here | Keep true |
| --- | --- | --- |
| AI provider behavior | `packages/acp/src/index.ts`, `packages/core/src/ai/`; read `docs/ACP.md` | ACP is provider-neutral; adapters stay in `core/src/ai/providers/`. |
| Core/Desktop operation | `packages/protocol/src/index.ts` -> `packages/core/src/server.ts` -> `packages/desktop/src/renderer/client.ts` | Define protocol types/registry first, then Core routing, then Desktop callers. |
| Renderer feature | `packages/desktop/src/renderer/{main.tsx,App.tsx,client.ts}` | Request workspace state from Core; do not access it locally. |
| Electron integration | package `src/electron/`, renderer `global.d.ts`, renderer callers | Search the IPC channel across all three. |
| Gateway/remote launch | `packages/gateway/src/{renderer,electron}` | Gateway deploys Core and ships Desktop artifacts; it does not import other workspaces. |
| Runtime/tooling | `scripts/`, then package-local `packages/{desktop,gateway}/scripts/` | Reuse existing launch/install helpers. |

Dependency direction is `acp -> protocol -> core/desktop`; Core and Desktop may
also use ACP directly. Runtime traffic is Desktop -> typed WebSocket protocol ->
Core services. Do not put provider-ID branches in shared protocol or UI when
provider descriptor metadata can express the behavior.

## Fast navigation

- Trace an operation: `rg '<request-or-event-name>' packages/protocol/src/index.ts packages/core/src/server.ts packages/desktop/src/renderer`.
- Core services are sibling modules of `packages/core/src/server.ts` (filesystem,
  search, Git, terminals, tasks/state, HTTP, Java/JDT LS).
- Colocated tests use `*.test.ts`/`*.test.tsx`; ACP fixture agents live at
  `packages/core/src/ai/providers/fake-acp-agent.{mjs,py}`.
- Product and operating context: `README.md`, `WHY.md`, `FEATURES.md`, and `docs/`.

## Checks and generated files

From the repository root after `npm install`:

```bash
npm run build
npm run typecheck                 # ACP/Protocol build; Core/Desktop check
npm run typecheck -w @remote-ide/gateway
npm test
```

Use `npm run {build|typecheck|test} -w @remote-ide/<package>` for targeted work.
Do not hand-edit `node_modules/`, `coverage/`, `packages/*/dist/`,
`packages/*/dist-electron/`, `packages/*/dist-renderer/`, `.tools/`, or
`.electron-runtime/`; regenerate them. Never commit `.env*` secrets or provider/MCP
configuration.
