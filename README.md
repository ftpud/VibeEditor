# Vibe Editor

Vibe Editor is an Electron desktop IDE for a local or remote workspace. A Node.js backend, Core, owns filesystem, terminal, Git, Java, HTTP, and AI operations; the React/Monaco desktop client talks to it over WebSockets and never receives an unrestricted server path.

This repository is under active development and currently targets source-based development and launches rather than packaged application releases.

## Requirements

- Node.js 20 or newer and npm.
- Git.
- A compiler toolchain supported by `node-pty` if npm cannot use a prebuilt binary.
- The platform libraries required by Electron.

Optional features have additional requirements:

- Java: Maven and a project JDK that provides `java`, `jdb`, `jimage`, and related tools. The installer downloads JDT LS and a Temurin 21 JRE used only to run the language server.
- Codex: valid Codex authentication/configuration in the account running Core. The Codex ACP server itself is an npm dependency of this repository; a separate `codex` executable is not required.
- Copilot: an installed and authenticated `copilot` CLI, or `COPILOT_CLI_PATH` pointing to it.
- Gateway: password-based SSH access to a host with Node.js 20+, npm, Git, and permission to run processes and modify the selected workspace. The local machine must also provide `tar` and Electron's platform dependencies.

## Install

Gateway is hard-coded to provision the `dev` branch, so use that branch when following the remote workflow:

```bash
git clone --branch dev https://github.com/ftpud/VibeEditor.git
cd VibeEditor
npm install
```

`npm install` attempts to download the pinned JDT LS and Temurin runtime. A download failure is reported as a warning because Java tooling is optional. Skip both downloads on a desktop-only installation with:

```bash
VIBE_SKIP_JDTLS=1 npm install
```

Install or repair them later on the machine running Core:

```bash
npm run install:jdtls
```

The bundled JRE installer supports Windows, macOS, and Linux on x64 or ARM64.

## Development

Core requires an absolute root workspace path. Start it first:

```bash
npm run dev:core -- --host 127.0.0.1 --port 7331 --workspace /absolute/path/to/project
```

Then start Desktop in another terminal:

```bash
npm run dev:desktop -- --host 127.0.0.1 --port 7331
```

Desktop connects automatically only when both options are supplied; otherwise it opens the connection screen. Core defaults to `127.0.0.1:7331`, but `--workspace` has no default. The development launchers compile Electron code, start Vite (`5173` for Desktop and `5174` for Gateway), and launch Electron. Core uses `tsx watch`.

Run Gateway in development with:

```bash
npm run dev:gateway
```

## Build and run

Build all five workspaces in dependency order:

```bash
npm run build
```

Run the compiled Core and Desktop:

```bash
npm run core -- --host 127.0.0.1 --port 7331 --workspace /absolute/path/to/project
npm run desktop -- --host 127.0.0.1 --port 7331
```

`npm run desktop` uses the existing build, so rebuild after source changes. Gateway rebuilds itself each time it starts:

```bash
npm run gateway
```

Useful checks are:

```bash
npm run typecheck
npm run typecheck -w @remote-ide/gateway
npm test
npm run build
```

The root `typecheck` script builds ACP and Protocol, then checks Core and Desktop; the explicit workspace command checks Gateway. Tests currently live in Core and run with Vitest. The build covers all workspaces.

## Remote connections

For direct network access, bind Core beyond loopback only on a trusted private network:

```bash
npm run core -- --host 0.0.0.0 --port 7331 --workspace /srv/projects/example
```

Core has no authentication or TLS. An SSH tunnel is the safer default:

```bash
# Run Core on 127.0.0.1:7331 on the remote host, then tunnel it locally.
ssh -N -L 8733:127.0.0.1:7331 user@remote-host
npm run desktop -- --host 127.0.0.1 --port 8733
```

### Vibe Gateway

Gateway stores SSH connections and remote workspace definitions in its Electron application-data directory. Passwords are encrypted with Electron `safeStorage`; public-key and SSH-agent authentication are not implemented.

- **Start server** clones or resets the `dev` branch in `~/.vibe`, conditionally installs dependencies/builds artifacts, selects a free loopback port if needed, and starts Core with workspace-specific PID and log files.
- **Start client** downloads and caches the remote Desktop build by Git revision, opens a local SSH tunnel, and launches it with the local Electron runtime. Keep Gateway open while using that tunnel.
- **Stop server** closes Gateway's tunnel and stops the Core process recorded for that workspace.

Known Gateway limitation: the current remote provisioning command builds Protocol, Core, and Desktop but omits the new ACP workspace. A fresh remote checkout can therefore fail before Core is built. Until provisioning is corrected, build ACP once on the remote host and retry **Start server**:

```bash
ssh user@remote-host 'cd ~/.vibe && npm run build -w @remote-ide/acp'
```

Gateway always resets its remote checkout to `origin/dev`; it does not deploy uncommitted local source changes.

## Features

- **Editor:** Monaco editing and diffs, autosave, external-change handling, detached windows, tab reordering, recursive search, Git gutter markers and block rollback, Markdown preview, and persisted themes/fonts/layout.
- **Terminal:** multiple workspace-specific `node-pty` terminals with restored tab metadata. Processes are recreated after a reconnect or task switch; dimensions and shell process state are not restored.
- **Git:** status and diffs, selective commits, push, checkout and branch rename, searchable graph/history, file/selection history, compare-with-ref, cherry-pick, and file or hunk rollback.
- **Task workspaces:** isolated Git worktrees on new, existing, or remote branches. A new task copies the root's staged, unstaged, untracked, ignored, and deleted-file state but excludes `node_modules`. Tasks can be compared with their recorded base and merged back with normal or smart merge.
- **AI:** a shared AI Capability Provider layer with Codex ACP and Copilot ACP adapters, model/configuration discovery, resumable sessions, permission prompts, usage data, attachments, steering, MCP servers, and global/local/workspace agent presets. See [docs/ACP.md](docs/ACP.md).
- **Vibe MCP tools:** an agent preset may opt into the built-in `vibe-editor` MCP server to create/list/delete task worktrees, start task agents, append prompts, inspect recent responses, and set the current task's commit-message draft without committing. It is not enabled when `mcpServers` is empty or omitted.
- **Java/Maven:** Maven project loading, source roots, JDT LS completion/navigation/diagnostics/semantic tokens, main-class run configurations, and `jdb` debugging.
- **HTTP and notes:** executable requests in `.http` files, executable shell blocks in Markdown, and global or workspace-local Useful Files.

## Architecture

The npm workspaces are:

- `@remote-ide/acp`: provider-neutral AI capability and session types.
- `@remote-ide/protocol`: typed WebSocket requests, responses, events, and DTOs shared by Core and Desktop.
- `@remote-ide/core`: the single-root, workspace-scoped backend and its services.
- `@remote-ide/desktop`: the Electron/React/Monaco IDE client.
- `@remote-ide/gateway`: the Electron SSH provisioner, tunnel owner, and Desktop launcher.

Each connected client is bound to the configured root or a Core-managed task worktree. Task switching replaces the active service context; clients cannot submit an arbitrary workspace path. Chokidar watches workspace and Git changes and Core sends typed refresh events to Desktop.

Core state defaults to:

```text
~/.remote-ide/workspaces
```

Override it before starting Core:

```bash
REMOTE_IDE_STATE_DIR=/var/lib/vibe-editor npm run core -- --workspace /srv/project
```

Core stores task registries/worktrees, workspace options, useful files, managed agent presets, AI session data, terminal restoration metadata, file colors, and commit drafts there. Workspace `.agents/*.md` presets remain in the project. Desktop stores UI settings in `settings.json` under its Electron application-data directory.

## Current limitations and security

- Core exposes one root workspace per process and has no authentication, authorization, or TLS. Anyone who can reach its port can modify files and run commands with Core's operating-system permissions. Do not expose it to the public internet.
- Filesystem methods reject parent traversal and symlinks escaping the active workspace, but this boundary does not make an exposed Core safe. Text files, useful files, agent files, HTTP bodies, and HTTP responses are limited to 2 MB where applicable; HTTP requests time out after 30 seconds.
- Task workspaces require the root to be a Git repository. Each task has an independent dependency tree, so run its package installation after switching when needed. Deleting a task forcibly removes its worktree and local task branch. Merging first commits all task changes; smart merge may stash and restore root changes.
- Gateway accepts username/password authentication only, depends on the fixed public repository and `dev` branch, and owns non-persistent tunnels. Closing Gateway closes its tunnels but does not stop remote Core unless **Stop server** is used.
- Java support is Maven-specific. The downloaded JRE runs JDT LS only; builds, runs, and debugging still depend on suitable project Java/Maven tools on the Core host.
- The editor opens existing UTF-8 text files only; binary and invalid UTF-8 files are rejected.

## License

Vibe Editor is available under the [MIT License](LICENSE.md).
