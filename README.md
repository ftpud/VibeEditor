# Vibe Editor

> **VibeEditor is an experimental testbed for remote-first, AI-first IDE ideas—not a production-ready product.**

VibeEditor is a place to explore what a remote-first, AI-first development environment can become when features can be vibecoded and implemented quickly. It is deliberately hackable rather than finished: the repository provides a working foundation, but anyone can fork it, replace parts of it, or build whatever workflow and IDE experience they want on top.

The experiment is built around a simple idea from [WHY.md](WHY.md): **the development machine is the server, and the local app is the control surface**.

<img width="1469" height="925" alt="screenshot" src="https://github.com/user-attachments/assets/5cef4748-aab8-4869-9cc6-a98c6fc1e81d" />


The repository, terminals, language servers, agents, builds, tests, and task state stay close to the compute. A lightweight React/Monaco desktop client provides the interaction layer over WebSockets. Tasks become durable workspaces—with their own Git worktree, editor state, terminals, AI sessions, notes, and Git state—rather than branches whose context must be reconstructed every time.

Vibe Editor is AI-first, not AI-only: agents can do the initial work, while the editor, terminal, Git tooling, HTTP files, executable Markdown, and Java tooling keep a human in control. It is intended as a sandbox for implementing and reviewing updates and features quickly, not as a replacement for every deep debugging, profiling, or framework-specific capability of a heavyweight IDE.

Expect rough edges, incomplete features, breaking changes, and assumptions tailored to the author's workflow. This repository is under active development and currently targets source-based development and launches rather than packaged application releases.

## Quick start: Vibe Gateway (recommended)

Use Gateway for the normal remote-first workflow. It installs and runs Core next to your project on the remote machine, then opens the Desktop UI locally through a private SSH tunnel. You do not need to manually clone Vibe Editor or start Core on the remote host.

Before starting, make sure the two machines have the following:

| Machine | Required for Gateway |
| --- | --- |
| **Local client** | Node.js 20+ and npm, Git (to clone this repository), `tar`, and the platform libraries required by Electron. A `node-pty` compiler toolchain is needed only if npm cannot use its prebuilt binary. |
| **Remote server** | A Unix-like SSH host reachable with a username and **password** (Gateway does not support SSH keys or an agent), Node.js 20+ and npm for that SSH user, Git, `bash`, `tar`, standard process utilities (`nohup`, `kill`, `sleep`, and `tail`), and permission to create `~/.vibe`, run processes, and modify the selected project directory. It must be able to reach GitHub to clone the fixed `dev` branch. A C/C++ compiler, `make`, and Python 3 are needed only if `node-pty` must be rebuilt. |

On the **local client**, clone the branch Gateway deploys, install dependencies, build, and launch Gateway:

```bash
git clone --branch dev https://github.com/ftpud/VibeEditor.git
cd VibeEditor
VIBE_SKIP_JDTLS=1 npm install
npm run build
npm run gateway
```

`VIBE_SKIP_JDTLS=1` skips the optional Java language-server download. Omit it if you want Java tooling; its requirements are listed below.

In Gateway's first run:

1. Add an SSH connection (host, port, username, and password).
2. Add a remote workspace using the absolute path to an existing project directory on that server.
3. Click **Start server**. Gateway clones or resets `~/.vibe` to `origin/dev`, installs/builds what changed, and starts remote Core on loopback.
4. Click **Start client** and keep Gateway open while using the editor; it owns the SSH tunnel.

For deployment details, caching behavior, and lifecycle notes, see [Vibe Gateway](#vibe-gateway). Use the direct Core/Desktop commands below only for local development, debugging, or when you intentionally manage Core and its connection yourself.

## Optional capabilities

Optional features have additional requirements:

- Java: Maven and a project JDK that provides `java`, `jdb`, `jimage`, and related tools. The installer downloads JDT LS and a Temurin 21 JRE used only to run the language server.
- Codex: valid Codex authentication/configuration in the account running Core. The Codex ACP server itself is an npm dependency of this repository; a separate `codex` executable is not required.
- Copilot: an installed and authenticated `copilot` CLI, or `COPILOT_CLI_PATH` pointing to it.

An `npm install` without `VIBE_SKIP_JDTLS=1` attempts to download the pinned JDT LS and Temurin runtime. A download failure is reported as a warning because Java tooling is optional. If you skipped that download, install or repair it later on the machine running Core:

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

Vibe Gateway automates both deployment and connection setup while preserving the remote-first model:

```text
local Vibe Gateway
    |
    | SSH: provision, start, stop, and transfer client artifacts
    v
remote host
    +-- ~/.vibe                         VibeEditor application checkout
    +-- configured project directory    repository and development state
    +-- Core on 127.0.0.1:<remote-port>
    |
    | SSH tunnel created by Gateway
    v
127.0.0.1:<temporary-local-port>
    |
    v
local Electron/Monaco Desktop
```

The deployment flow is:

1. **Save a connection and workspace.** Gateway stores the SSH host and remote project directory in its Electron application-data directory. The SSH password is encrypted with Electron `safeStorage`; public-key and SSH-agent authentication are not currently implemented.
2. **Provision the remote application.** **Start server** connects over SSH and clones `https://github.com/ftpud/VibeEditor` into `~/.vibe`, or fetches and force-resets an existing checkout to `origin/dev`. This is the application installation; the configured project workspace remains in its own remote directory.
3. **Build only when needed.** Gateway records the deployed Git revision in `~/.vibe-build`. If the revision changed, dependencies or build outputs are missing, or `node_modules` is absent, it runs `npm install` and builds ACP, Protocol, Core, and Desktop. Otherwise it reuses the existing build.
4. **Start remote Core.** Gateway tries the configured Core port and chooses a free fallback when it is occupied. It launches Core with `nohup`, bound only to remote loopback, and passes the configured project directory as the workspace root. Each Gateway workspace gets its own PID and log files in the remote home directory.
5. **Prepare the local client.** **Start client** identifies the remote deployment by Git revision. If that Desktop build is not already cached locally, Gateway archives the remotely built Electron main process and renderer, downloads them over SFTP, and extracts them under Gateway's application-data directory.
6. **Create the private connection.** Gateway opens an SSH connection and exposes a temporary port on local `127.0.0.1`. Connections to that port are forwarded to Core's remote loopback port, so Core does not need a public listener, authentication layer, or TLS endpoint.
7. **Launch the UI locally.** Gateway starts the downloaded Desktop code with the local Electron runtime and passes the tunnel's host and port. The UI is rendered locally; filesystem access, terminals, Git, builds, language services, agents, and durable task state continue to run remotely.

Keep Gateway open while using a client because it owns the SSH tunnel. Closing Gateway closes its tunnels but leaves remote Core running; **Stop server** closes the tunnel and terminates the Core process recorded for that workspace.

Gateway deploys only committed code from the fixed `dev` branch. It always resets the remote application checkout to `origin/dev` and does not copy uncommitted local source changes.

## Features

- **Editor:** Monaco editing and diffs, autosave, external-change handling, detached windows, tab reordering, recursive search, Git gutter markers and block rollback, Markdown preview, and persisted themes/fonts/layout.
- **Terminal:** multiple workspace-specific `node-pty` terminals with restored tab metadata. Processes are recreated after a reconnect or task switch; dimensions and shell process state are not restored.
- **Git:** status and diffs, selective commits, push, checkout and branch rename, searchable graph/history, file/selection history, compare-with-ref, cherry-pick, and file or hunk rollback.
- **Task workspaces:** isolated Git worktrees on new, existing, or remote branches. A new task copies the root's staged, unstaged, untracked, ignored, and deleted-file state but excludes `node_modules`. Tasks can be compared with their recorded base and merged back with normal or smart merge.
- **AI:** a shared AI Capability Provider layer with Codex ACP and Copilot ACP adapters, model/configuration discovery, resumable sessions, permission prompts, usage data, attachments, steering, MCP servers, and global/local/workspace agent presets. See [docs/ACP.md](docs/ACP.md).
- **Vibe MCP tools:** an agent preset may opt into the built-in `vibe-editor` MCP server to create/list/delete task worktrees, start provider/model sessions with an inherited, configured, or explicitly absent agent preset and validated reasoning effort, select a validated model/reasoning pair for its next turn, append prompts, inspect recent responses, set the current task's commit-message draft, and safely update the latest unpushed commit message for an explicit task ID. It is not enabled when `mcpServers` is empty or omitted; task-start examples are in [docs/ACP.md](docs/ACP.md#starting-tasks-through-the-vibe-editor-mcp-server).
- **Java/Maven:** Maven project loading, source roots, JDT LS completion/navigation/diagnostics/semantic tokens, main-class run configurations, and `jdb` debugging.
- **HTTP and notes:** executable requests in `.http` files, executable shell blocks in Markdown, and global or workspace-local Useful Files.

## Architecture

The npm workspaces are:

- `@remote-ide/acp`: provider-neutral AI capability and session types.
- `@remote-ide/protocol`: typed WebSocket requests, responses, events, and DTOs shared by Core and Desktop.
- `@remote-ide/core`: the single-root, workspace-scoped backend and its services.
- `@remote-ide/desktop`: the Electron/React/Monaco IDE client.
- `@remote-ide/gateway`: the Electron SSH provisioner, tunnel owner, and Desktop launcher.

This split follows the project's core rule: **the server owns the state; the client owns the interaction**. Each connected client is bound to the configured root or a Core-managed task worktree. Task switching replaces the active service context; clients cannot submit an arbitrary workspace path. Chokidar watches workspace and Git changes and Core sends typed refresh events to Desktop.

Core state defaults to:

```text
~/.remote-ide/workspaces
```

Override it before starting Core:

```bash
REMOTE_IDE_STATE_DIR=/var/lib/vibe-editor npm run core -- --workspace /srv/project
```

Core stores task registries/worktrees, workspace options, useful files, managed agent presets, AI session data, terminal restoration metadata, file colors, and commit drafts there. Workspace `.agents/*.md` presets remain in the project. Desktop stores UI settings in `settings.json` under its Electron application-data directory.

Task Git prompt checkpoints are also stored there as content-addressed snapshots outside the repository. See [Task Git prompt history](docs/TASK_GIT_HISTORY.md).

## Current limitations and security

- Core exposes one root workspace per process and has no authentication, authorization, or TLS. Anyone who can reach its port can modify files and run commands with Core's operating-system permissions. Do not expose it to the public internet.
- Filesystem methods reject parent traversal and symlinks escaping the active workspace, but this boundary does not make an exposed Core safe. Text files, useful files, agent files, HTTP bodies, and HTTP responses are limited to 2 MB where applicable; HTTP requests time out after 30 seconds.
- Task workspaces require the root to be a Git repository. Each task has an independent dependency tree, so run its package installation after switching when needed. Deleting a task forcibly removes its worktree and local task branch. Merging first commits all task changes; smart merge may stash and restore root changes.
- Gateway accepts username/password authentication only, depends on the fixed public repository and `dev` branch, and owns non-persistent tunnels. Closing Gateway closes its tunnels but does not stop remote Core unless **Stop server** is used.
- Java support is Maven-specific. The downloaded JRE runs JDT LS only; builds, runs, and debugging still depend on suitable project Java/Maven tools on the Core host.
- The editor opens existing UTF-8 text files only; binary and invalid UTF-8 files are rejected.

## License

Vibe Editor is available under the [MIT License](LICENSE.md).
