# Plugins

Plugins add AI providers and language services to Core without editing shared
code. Prefer a [declarative provider](ACP.md#declarative-providers) when you only
need to start an ACP agent; use a plugin for code.

## Trust model

- **Opt-in, host-only.** Core loads plugins only when the operator sets
  `REMOTE_IDE_PLUGINS_DIR` on the Core host. Nothing is loaded from a workspace,
  and Desktop cannot install, enable or disable plugins (it only lists them via
  `plugins.list`).
- **A plugin is arbitrary code running as the Core user.** It can read workspace
  files, spawn processes and use the network. Install only code you trust, as you
  would for any server-side extension.
- **Isolation is for faults, not for malice.** A plugin that fails validation,
  throws on import, mismatches its manifest or claims a taken ID is reported in
  `plugins.list` and skipped. A provider factory that throws is skipped at
  startup; a language service that throws fails only its own requests.

## Layout

```
<REMOTE_IDE_PLUGINS_DIR>/<name>/plugin.json
<REMOTE_IDE_PLUGINS_DIR>/<name>/<core entry>.mjs
```

```json
{
  "id": "my-plugin", "version": "1.0.0", "apiVersion": 1,
  "contributes": { "providers": ["my-agent"], "languages": ["my-lang"] },
  "core": "index.mjs"
}
```

The entry module exports `apiVersion` (must equal `PLUGIN_API_VERSION`, now 1),
and optionally `providers: [{ id, create(ctx) }]` (a `ProviderFactory` receiving
`ProviderContext`) and `languages: [{ descriptor, create(workspace, events) }]`
(a `LanguageService`, see `packages/core/src/language/service.ts`). The module's
exports must match `contributes` exactly. Provider IDs `codex`, `claude`,
`copilot` and IDs of other loaded plugins/languages are rejected.

## Security review notes

Reviewed in `packages/core/src/plugins/loader.ts`:

- `core` must be a relative path without `..` and is checked to stay inside the
  plugin directory. Symlinks are not resolved; the directory is operator-owned,
  so a symlink there is the operator's choice.
- ES modules are cached by URL: updating a plugin needs a Core restart.
- Plugins share the Core process. There is no sandbox or permission model in API
  version 1; do not run untrusted plugins. A future version may run plugins in a
  separate process.
- The renderer half (contributing UI bundles from the remote Core) is not
  implemented: the only Desktop surface is the read-only plugin list.

## Built-in plugin layout

Built-ins use the same contracts as external plugins and each lives in its own
directory inside the Core package, with its tests and fixtures:

```
packages/core/src/plugins/
  builtin.ts            the only module shared Core imports to reach built-ins
  ai/<id>/              AI providers (index.ts exports the provider factory)
  languages/java/       Java service, JDT LS, Maven/config, caches, host tools
  languages/node/       Node (npm scripts) service
  loader.ts             external plugin loader (REMOTE_IDE_PLUGINS_DIR)
```

Java-only Desktop UI mirrors this under `packages/desktop/src/renderer/plugins/languages/java/` (bundled statically; remote renderer bundles stay deferred). Shared pieces such as `DebugVariable` and `ProjectTree` stay in the renderer root.

`plugins/isolation.test.ts` fails when shared code imports a plugin directory
directly, or when one plugin imports another. Plugin-owned workspace-state
fields (Java) register their validators with `registerWorkspaceStateValidator`;
host tools register through `registerTools`.
