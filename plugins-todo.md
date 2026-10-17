# Plugins TODO

Goal: make AI providers and language support (starting with Java) replaceable
modules behind shared interfaces, so new ones can be added without editing
shared Core, protocol or UI code.

Order matters: do the AI provider work first (cheap, mostly done), then the
language-service interface, and only then a real plugin loader. Do not design
the loader before there are at least two internal implementations to shape it.

## Part 1: AI providers

Already in place: `AcpProvider` (`packages/acp/src/index.ts`), `AcpRegistry`
(`packages/core/src/ai/acp.ts`), `StdioAcpProvider`, provider descriptors, and
the composition root `createAcpRegistry` (`packages/core/src/ai/index.ts`).

### 1.1 Remove provider-ID branches
- [x] Audited provider-ID hits; remaining mentions are test fixtures, starter config, and the legacy Codex cache migration.
- [x] Replace each branch with descriptor metadata (capabilities, options, settings layout) or a new optional descriptor field.
- [x] Move provider-specific helpers (e.g. `codex-usage.ts`) behind the provider's own `usage()` so shared code never imports them.
- [x] Keep `providers.test.ts` green; add a test that fails if shared code mentions a built-in provider ID.

### 1.2 Declarative providers (no code loading)
- [ ] Define a provider definition file format (JSON/TOML): `id`, `name`, `description`, `command`, `args`, `env`, credential variable names, fallback models, `options`, `capabilities`, protocol versions.
- [ ] Validate definitions with a strict schema; reject unknown fields and duplicate/reserved IDs.
- [ ] Implement `ConfiguredStdioProvider extends StdioAcpProvider` built from a definition (generic `command()`, `fallbackModels()`, `installationSpec`).
- [ ] Extend `InstallationSpec` (`provider-installations.ts`) beyond npm packages: user-supplied binary path, and "external" source with no managed install.
- [ ] Load definitions from a Core-host directory (e.g. `<core-config>/providers/*.json`) in `createAcpRegistry`; log and skip invalid files instead of failing startup.
- [ ] Add a fixture definition pointing at `fake-acp-agent.mjs` and cover: registration, model listing, send, permission, usage fallback.
- [ ] Document the format in `docs/ACP.md`.

### 1.3 Public provider context and built-ins on the same path
- [ ] (ProviderContext type exists and factories use it; constructors still positional) Replace the internal constructor arguments (`onChanged`, `turns`, `projectRoot`, `bridgeWorkspace`) with a single `ProviderContext` object.
- [x] Export `StdioAcpProvider` and `ProviderContext` as a versioned, documented API (`PROVIDER_API_VERSION`).
- [x] Define `createProvider(ctx)` as the factory signature; convert Codex, Copilot and Claude to it.
- [x] Make `createAcpRegistry` iterate a list of factories instead of hard-coded `.register(...)` calls.

### 1.4 Code plugins (only if declarative is not enough)
- [ ] Decide trust model: opt-in, directory configured on the Core host, never loaded from a workspace.
- [ ] Load ES modules exporting `{ apiVersion, createProvider }`; reject mismatched `apiVersion`.
- [ ] Isolate failures: a throwing plugin must not break startup or other providers.
- [ ] Surface plugin source (`built-in` / `definition` / `plugin`) in `AiProviderInstallation.source` so the UI can show it.

## Part 2: Language support (Java first)

Current state: Java is wired through `core/src/java*.ts`, `jdtls.ts`, the `java.*`
requests in `protocol/src/index.ts` (~96 lines), `server.ts` (~52 refs),
`workspace-state.ts` (~22), `tools.ts`, and renderer `model.ts`,
`command-registry.ts`, `debug-editor.tsx`, `DebugVariable.tsx`.

### 2.1 Map the coupling
- [ ] List every Java reference in `server.ts`, `workspace-state.ts`, `tools.ts`, `websocket-output.ts` and the renderer; classify each as: language-specific, generic-but-named-Java, or genuinely shared.
- [ ] Write the result into a short design note (`docs/LANGUAGES.md`) with a sizing estimate.

### 2.2 Define the language-service contract
- [ ] Core interface `LanguageService` covering: project detection/loading, project tree, source roots, workspace symbols, tool checks, configuration read/save.
- [ ] Run/build side: `listRunTargets`, `build`, `run`, `stop`, run-configuration add/select (reuse `run-configs.ts` / `project-processes.ts` rather than adding a parallel path).
- [ ] Debug side: breakpoints, start, variables, apply changes, step commands, expressed over DAP-shaped types where possible.
- [ ] LSP side: launch spec for the language server (command, args, init options) so Core owns one generic LSP host instead of `jdtls.ts` being special.
- [ ] Capability flags per service (`build`, `run`, `debug`, `lsp`, `projectTree`) so the UI hides what is unsupported.
- [ ] A `LanguageRegistry` with file-type/project detection (generalise `java-file-type.ts`).

### 2.3 Generic protocol surface
- [ ] Add language-neutral requests/events to `packages/protocol/src/index.ts` (e.g. `language.projectTree`, `language.build`, `language.run`, `language.debug.*`), carrying a `language` id.
- [ ] Route them in `server.ts` through `LanguageRegistry`.
- [ ] Keep the existing `java.*` requests as thin aliases during migration, then remove them once Desktop callers move.
- [ ] Decide how language-specific extras are typed (typed union per built-in language vs. an opaque `extra` payload with a schema from the service descriptor).

### 2.4 Move Java onto the contract
- [ ] Implement `JavaLanguageService` by wrapping the existing modules (`java.ts`, `jdtls.ts`, `java-configuration.ts`, caches); no behaviour change.
- [ ] Move `.settings/java.json` handling and Maven loading inside it.
- [ ] Replace Java calls in `server.ts`, `workspace-state.ts` and `tools.ts` with registry lookups.
- [ ] Keep `java.test.ts`, `jdtls.test.ts`, `java-debug.integration.test.ts` passing unchanged as the regression suite.

### 2.5 Renderer side
- [ ] Switch Desktop callers in `client.ts` to the `language.*` requests.
- [ ] Make debug UI (`debug-editor.tsx`, `DebugVariable.tsx`) driven by capability flags and generic debug types, not Java names.
- [ ] Drive project tree, run configurations and commands (`command-registry.ts`) from the language descriptor.
- [ ] Rename Java-named generic UI (Git dialogs, `model.ts` fields) where they are not Java-specific.

### 2.6 Prove the interface with a second language
- [ ] Add a minimal second `LanguageService` (e.g. Node/TypeScript via `typescript-language-server`, or Python via `pyright`) as a built-in.
- [ ] Fix whatever in the contract turns out to be Java-shaped.

## Part 3: Plugin loader (after Parts 1 and 2)

- [ ] Plugin manifest: `id`, `version`, `apiVersion`, `contributes` (providers, languages, run kinds, workflow steps), `core` entry, optional `renderer` entry.
- [ ] Core loader with opt-in directory, version checks, per-plugin error isolation and a status listing request.
- [ ] Renderer half: contribute debug/inspector UI only via declared capabilities; decide how renderer bundles are delivered from the remote Core to Desktop.
- [ ] Settings UI to list, enable and disable plugins.
- [ ] Security review (`/security-review`): plugins run arbitrary code on the Core host.

## Later candidates (not part of this effort)

- Run configuration and process kinds.
- Workflow step types (`workflow-*`, `harnesses.ts`).
- Trigger and schedule event sources.
- File-type handlers and viewers in the renderer.

## Checks for every step

```bash
npm run build
npm run typecheck
npm run typecheck -w @remote-ide/gateway
npm test
```
