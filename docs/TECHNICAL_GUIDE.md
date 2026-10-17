# Vibe Editor technical guide

For the shortest path to your first workspace, start with the [README](../README.md).
This guide covers detailed requirements, deployment, development, architecture, and limitations.
Run the commands below from the repository root.

## Quick start: Vibe Gateway (recommended)

Use Gateway for the normal remote-first workflow. It installs and runs Core next to your project on the remote machine, then opens the Desktop UI locally through a private SSH tunnel. You do not need to manually clone Vibe Editor or start Core on the remote host.

Before starting, make sure the two machines have the following:

| Machine | Required for Gateway |
| --- | --- |
| **Local client** | Node.js 22.12+ and npm, Git (to clone this repository), `tar`, and the platform libraries required by Electron. A `node-pty` compiler toolchain is needed only if npm cannot use its prebuilt binary. |
| **Remote server** | A Unix-like SSH host reachable with a username and either a password or an already-authorized SSH private key, Node.js 22.12+ and npm for that SSH user, Git, `bash`, `tar`, standard process utilities (`nohup`, `kill`, `sleep`, and `tail`), and permission to create `~/.vibe`, run processes, and modify the selected project directory. It must be able to reach the Git repository selected in Gateway settings. A C/C++ compiler, `make`, and Python 3 are needed only if `node-pty` must be rebuilt. |

On the **local client**, clone this repository, install dependencies, build, and launch Gateway:

```bash
git clone https://github.com/ftpud/VibeEditor.git
cd VibeEditor
npm install
npm run build
npm run gateway
```

In Gateway's first run:

1. Add an SSH connection with host, port, and username. Choose **Password**, **SSH agent** (for keys already loaded in your OS agent), or **Private key** with a local key file and optional passphrase. The matching public key must already be in the remote user's `~/.ssh/authorized_keys`; Gateway does not install or copy public keys. Use **Test connection** to verify the current form values before saving.
2. Review **Gateway repository settings**. The default repository is `https://github.com/ftpud/VibeEditor` on branch `main`; choose a different repository or branch if needed. Auto-update is enabled by default.
3. Add a remote workspace using the absolute path to an existing project directory on that server.
4. Click **Start server**. Gateway clones the selected repository and branch into `~/.vibe`, installs/builds what changed, and starts remote Core on loopback.
5. Click **Start client** and keep Gateway open while using the editor; it owns the SSH tunnel.

Gateway also supports a **This Mac** connection: select a local project directory, then start Core and Desktop from the existing local build without SSH.

For deployment details, caching behavior, and lifecycle notes, see [Vibe Gateway](#vibe-gateway). Use the direct Core/Desktop commands below only for local development, debugging, or when you intentionally manage Core and its connection yourself.

## Optional capabilities

Optional features have additional requirements:

- Java: Maven and a project JDK that provides `java`, `jdb`, `jimage`, and related tools. Java highlighting, completion and navigation also need the **Java runtime** (a pinned Temurin 21 JRE used only to run the language server) and the **Java language server** (JDT LS), downloaded to the Core host from **Settings → Tools**.
- AI providers: install Codex, Claude or Copilot from **Settings → AI providers** (npm access from the Core host is required). Only installed providers are usable. The same panel checks and performs sign-in.
- Codex: valid Codex authentication/configuration in the account running Core. The installed adapter brings its own `codex` CLI.
- Copilot: an authenticated Copilot account. `COPILOT_CLI_PATH` can point to an existing `copilot` CLI instead of installing one.
- Claude: a Claude Code login on the Core host (`claude` then `/login`), or `ANTHROPIC_API_KEY` in Core's environment. The installed ACP adapter bundles its CLI.

Settings → Tools downloads the pinned, checksum-verified Java tools into `~/.remote-ide/tools/` on the Core host (`REMOTE_IDE_TOOLS_DIR` relocates it), shared by all projects. Installing the language server also installs the runtime when it is missing. A failed download keeps the previous installation. Neither `npm install`, Gateway provisioning nor Early Access bundles download Java anymore.

## Development

Core requires an absolute root workspace path. Start it first:

```bash
npm run dev:core -- --host 127.0.0.1 --port 7331 --workspace /absolute/path/to/project
```

Then start Desktop in another terminal:

```bash
npm run dev:desktop -- --host 127.0.0.1 --port 7331
```

Desktop connects automatically only when both options are supplied; otherwise it opens the connection screen. Core defaults to `127.0.0.1:7331`, but `--workspace` has no default. The development launchers compile Electron code, start Vite (`5173` for Desktop and `5174` for Gateway), and launch Electron. Core uses `tsx watch`. Its development launcher allows the exact Desktop origins `http://localhost:5173` and `http://127.0.0.1:5173` in addition to any configured `REMOTE_IDE_ALLOWED_ORIGINS`; session authentication remains required.

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

The source launch commands build their dependencies before starting. Gateway builds Core and Desktop too, so its local-workspace controls work from a clean checkout. Missing Electron binaries are installed on first launch. If the current Node is older than 22.12, the launcher selects Node 24 through npm; Gateway passes that same Node executable to local Core. The first launch may need network access for these runtimes. On macOS, source apps also receive their native app icons.

Start Gateway with:

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

The root `typecheck` script builds ACP and Protocol, then checks Core and Desktop; the explicit workspace command checks Gateway. The root test command runs the Core, Desktop, and Gateway test suites; the workspace scripts use Vitest and Node's test runner. The build covers all workspaces.

## Remote connections

Gateway loads the remote user's NVM without activating its default alias, then
selects an installed Node 24 for Vibe's builds, Core launches, and health checks.
If Node 24 is absent, it tries NVM's newest installed Node and requires 22.12+.
Your default can remain Node 20: Gateway changes only the environment of its own
remote commands and never changes NVM aliases or installs Node automatically.
Run `nvm install 24` once on the remote host to provide the preferred runtime.
An existing `NVM_DIR` is respected; otherwise Gateway uses `~/.nvm`.
Hosts without NVM can still use a Node 22.12+ installation available on PATH.

For direct network access, bind Core beyond loopback only on a trusted private network:

```bash
npm run core -- --host 0.0.0.0 --port 7331 --workspace /srv/projects/example
```

Core uses a session token for authentication. SSH tunnelling keeps its listener
on remote loopback; see [release operations](RELEASE_OPERATIONS.md#core-session-credentials-and-origins)
for token handling and origin checks:

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
    +-- ~/.vibe-deploy/releases/       immutable Vibe Core builds
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

Gateway saves SSH credentials and an explicitly trusted host-key fingerprint.
Source-mode provisioning builds immutable releases under `~/.vibe-deploy/`;
packaged Gateway uploads a matching bundled Core archive. Activation verifies
an authenticated protocol handshake and can roll back a failed candidate.
Desktop runs locally and reaches remote Core through Gateway's SSH tunnel.
Filesystem access, terminals, Git, builds, language services and durable state
remain on Core.

Keep Gateway open while using a client because it owns the SSH tunnel. Closing
Gateway closes its tunnels but leaves remote Core running; **Stop server** stops
the selected workspace's server. Source deployment uses committed code from the
configured repository/branch and does not copy uncommitted local changes.

See [release operations](RELEASE_OPERATIONS.md) for provisioning, repair and
rollback, and [Early Access bundles](EARLY_ACCESS.md) for packaged runtime behavior.

## Features

- **Editor:** Monaco editing and diffs, autosave, external-change handling, detached windows, tab reordering, recursive search, Git gutter markers and block rollback, Markdown preview, and persisted themes/fonts/layout.
- **Terminal:** multiple workspace-specific `node-pty` terminals with restored tab metadata. Live Core-owned processes reattach after reconnect or task switching. If the previous session is unavailable during recovery, Desktop reports it and requires an explicit replacement; it does not reconstruct the old process environment or working directory.
- **Git:** status and diffs, selective commits, push, checkout and branch rename, searchable graph/history, file/selection history, compare-with-ref, cherry-pick, and file or hunk rollback.
- **Task workspaces:** isolated Git worktrees on new, existing, or remote branches. A new task copies the root's staged, unstaged, untracked, ignored, and deleted-file state but excludes `node_modules`. Tasks can be compared with their recorded base and merged back with normal or smart merge.
- **AI:** a shared AI Capability Provider layer with Codex ACP, Copilot ACP, and Claude ACP adapters, model/configuration discovery, resumable sessions, permission prompts, usage data, attachments, steering, MCP servers, and global/local/workspace agent presets. See [docs/ACP.md](ACP.md).
- **Vibe MCP tools:** agents can manage task worktrees, merge completed work, inspect usage, schedule continuations, hand off to a fresh session, and call connected workflow blocks. Enable the built-in `vibe-editor` server through an agent preset. See the [tool reference and examples](MCP.md).
- **Java/Maven:** Maven project loading, source roots, JDT LS completion/navigation/diagnostics/semantic tokens, editable launch profiles and tool settings, `jdb` debugging with object/array inspection, and paused-session HotSwap. See [Java debugging](JAVA_DEBUGGING.md).
- **HTTP and notes:** executable requests in `.http` files, executable shell blocks in Markdown, and global or workspace-local Useful Files.
- **Multiple roots:** register remote project directories with aliases in one Core connection, retaining root-owned editor and terminal tabs. See [Multi-root protocol boundary](MULTI_ROOT.md).
- **Workflows:** a visual block editor connects AI agents, scripts, timers, user input, and documents, with templates, run history, and pause/retry/cancel controls.
- **Run configurations:** global and project-local shell scripts with dedicated terminals and Run/Stop/Restart controls. See [Run Configurations](RUN_CONFIGS.md).
- **Project files:** create, rename, copy/move, recoverable deletion, local upload/remote download, and previewed search replacement.

See [FEATURES.md](../FEATURES.md) for the detailed feature inventory.

## Architecture

The npm workspaces are:

- `@remote-ide/acp`: provider-neutral AI capability/session types, provider base class, and configuration helpers.
- `@remote-ide/protocol`: typed WebSocket requests, responses, events, and DTOs shared by Core and Desktop.
- `@remote-ide/core`: the backend managing registered workspace roots, task worktrees, and their services.
- `@remote-ide/desktop`: the Electron/React/Monaco IDE client.
- `@remote-ide/gateway`: the Electron SSH provisioner, tunnel owner, and Desktop launcher.

This split follows the project's core rule: **the server owns the state; the client owns the interaction**. Core starts with one primary workspace root; Desktop can register additional directories on the Core host and switch between them. Each client selects a registered root and its root or task-worktree context. Root-owned requests and events carry Core-issued identities; ordinary operations cannot submit an arbitrary workspace path. Chokidar watches workspace and Git changes and Core sends typed refresh events to Desktop.

Core state defaults to:

```text
~/.remote-ide/workspaces
```

Override it before starting Core:

```bash
REMOTE_IDE_STATE_DIR=/var/lib/vibe-editor npm run core -- --workspace /srv/project
```

Core stores task registries/worktrees, workspace options, useful files, managed agent presets, AI session data, terminal restoration metadata, file colors, and commit drafts there. Workspace `.agents/*.md` presets remain in the project. Desktop stores UI settings in `settings.json` under its Electron application-data directory.

Task Git prompt checkpoints are also stored there as content-addressed snapshots outside the repository. See [Task Git prompt history](TASK_GIT_HISTORY.md).

### Server storage cleanup

Open **Settings → Storage…** to calculate allocated disk usage across the connected SSH account's shared Vibe state directory. Core scans in the background and refreshes totals after removal. The panel inventories tasks, sessions, workflow records, snapshots, provider data, agent runtimes, Gateway releases and source caches. It does not scan other users' accounts or unrelated custom state directories. Workflow aliases do not count as additional workspace copies; shared hardlinks across separately measured units may count more than once.

Task bars distinguish active (red), finished (blue), and unregistered (amber) workspaces. Unregistered folders are leftovers missing from a task registry, including interrupted task creation and integration worktrees; they can still contain recoverable changes. **Remove finished** preserves branches and skips dirty, selected and busy tasks. **Keep root & active** additionally removes inactive unregistered folders and associated checkpoints, and requires explicit acknowledgement that uncommitted changes will be discarded. Registered project roots, active tasks, ongoing integrations and workspaces used by processes or active workflows remain protected. The expandable inventory lists the paths and states before removal. Legacy independent task repositories have their HEAD and branches imported under `recovered/<task-id>/` in the root repository before deletion.

History bars distinguish today, the preceding seven days excluding today, and older data. **Remove older than 7 days** removes eligible old records; **Keep today only** keeps everything from server-local midnight onward. Archived AI conversations, ended workflow runs, inactive finished-task checkpoint stores, abandoned workflow temporary files and rotated server logs can be removed. Workflow totals measure allocated bytes; their per-run age shares and reclaimable sizes are estimates. Workflow cleanup rewrites both current records and their recovery backup. File removal rechecks previewed identities, sizes, modification times and symlink ancestors.

On Linux, **Keep current version** keeps the connected Core's actual release and selected agent runtime, removes obsolete versions and rebuildable deployment source caches, and updates runtime/rollback metadata. The preview requires acknowledgement that other Vibe sessions for the same SSH account will close. Core verifies process ownership, script identity and process birth before signaling other Core instances and their descendants, plus workers using obsolete runtimes. The current Core connection, its ancestors, unrelated processes and other users are preserved. Processes that do not shut down gracefully are terminated; versions still in use by an unrelated process are retained. Version maintenance locks runtime installation and Gateway provisioning/activation so builds cannot overlap removal. Future Gateway connections may download or build again.

Current conversations, active workflows, command bridge state, unidentified checkpoint stores, provider databases and their linked native histories, settings and credentials remain protected and visible. Previews are tied to server scan identities; clients cannot provide deletion paths. Cleanup continues if the panel closes, and graceful Core shutdown waits for the job.

Workflow errors appear as one-line disclosures with a scrollable full diagnostic. Chatbox steering is acknowledged after durable acceptance rather than waiting for the ACP extension response. Steering appears after prior conversation text, and subsequent assistant output continues beneath it; delayed delivery failures appear in the error disclosure.

## Current limitations and security

- Core supports multiple workspace roots and authenticates clients with a session token. Authenticated clients operate with the Core user's filesystem and process permissions; there is no per-user authorization sandbox. Gateway uses SSH tunnelling, and Core has no native TLS endpoint. See [release operations](RELEASE_OPERATIONS.md#core-session-credentials-and-origins) for deployment controls.
- Filesystem methods reject parent traversal and symlinks escaping the active workspace, but this boundary does not make an exposed Core safe. Text files, useful files, agent files, HTTP bodies, and HTTP responses are limited to 2 MB where applicable; HTTP requests time out after 30 seconds.
- Task workspaces require the root to be a Git repository. Each task has an independent dependency tree, so run its package installation after switching when needed. Deleting a task forcibly removes its worktree and local task branch. Merging first commits all task changes; smart merge may stash and restore root changes.
- Gateway supports password, local private-key, and OS SSH-agent authentication. It pins the explicitly trusted server SHA-256 host-key fingerprint, deploys the saved repository and branch, and owns non-persistent tunnels. Closing Gateway closes its tunnels but does not stop remote Core unless **Stop server** is used.
- If private-key authentication fails, select the private key itself (such as `~/.ssh/id_ed25519`), not its `.pub` companion. Gateway validates RSA, ECDSA, Ed25519, and OpenSSH key files locally and reports missing or incorrect passphrases before connecting. If the server rejects a valid key, verify that its matching public key is present in the selected remote user's `~/.ssh/authorized_keys`.
- Java support is Maven-specific. The Java runtime from Settings → Tools runs JDT LS only; builds, runs, and debugging still depend on suitable project Java/Maven tools on the Core host.
- The editor opens existing UTF-8 text files only; binary and invalid UTF-8 files are rejected.



## Early Access bundles and provider installations

Portable Core bundles contain Vibe's runtime and provider-neutral ACP transport,
not vendor ACP adapters, Codex/Claude/Copilot CLIs, or vendor SDKs; neither does a
source checkout. Providers are installed, updated and deleted from **Settings → AI
providers** into `~/.remote-ide/provider-runtimes/` on the Core host, are cached across
projects and Core restarts, and only installed providers can be used. Failed downloads
never replace a working installation. Nothing is downloaded just to start Core. See
[ACP](ACP.md#installing-providers) for overrides such as `CODEX_ACP_COMMAND`,
`CLAUDE_AGENT_ACP_PATH` and `COPILOT_CLI_PATH`.

Application bundles contain only their Electron main-process dependency closure;
renderer dependencies are already compiled into the UI. Desktop contains no Core
archives. Gateway includes one set of architecture-specific Core archives and its
Desktop client. Native dependencies cannot share a single node_modules tree across
Linux/macOS and different CPU architectures.

To build the first Apple Silicon bundle entirely on an Apple Silicon Mac:

```bash
npm run build
npm run bundle:core
npm run bundle:apps -- --local
```

The local bundle includes only macOS ARM64 Core; it cannot provision Linux hosts.
Applications and ZIP downloads are written to `artifacts/apps` and
`artifacts/downloads`. Normal CI builds include all supported Core targets.
