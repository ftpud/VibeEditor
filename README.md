# Vibe Editor

Vibe Editor is a remote-workspace IDE built with Electron, React, Monaco Editor, Node.js, and WebSockets. The backend runs beside the project and owns filesystem, terminal, Git, Java, and AI operations. The desktop connects using only the backend IP address and port.

The repository contains four npm workspaces:

- `@remote-ide/core`: workspace-scoped WebSocket backend.
- `@remote-ide/desktop`: Vibe Editor Electron client.
- `@remote-ide/gateway`: SSH connection, remote server, tunnel, and desktop launcher.
- `@remote-ide/protocol`: shared request, response, event, and DTO types.

## Requirements

For local development and direct installs:

- Node.js 20 or newer.
- npm 10 or newer.
- Git.
- A compiler toolchain supported by `node-pty` when a prebuilt binary is unavailable.

Optional backend tools:

- Java development: Maven, a project JDK, `jdb`, and the bundled JDT Language Server runtime.
- Codex integration: an installed and authenticated `codex` CLI.
- Copilot integration: an installed and authenticated `copilot` CLI.

Gateway remote hosts need Node.js 20+, npm, Git, SSH access, and permission to read and write the configured workspace and run processes there. Gateway currently connects with a username and password. The machine running Gateway needs Electron dependencies but does not need to compile the Desktop application for every launch.

## Install

```bash
git clone --branch dev https://github.com/ftpud/VibeEditor.git
cd VibeEditor
npm install
```

`npm install` runs the JDT LS installer. To install Desktop or Gateway without downloading Java tooling:

```bash
VIBE_SKIP_JDTLS=1 npm install
```

Install or repair Java language tooling later with:

```bash
npm run install:jdtls
```

## Development

Start Core with the absolute path of the only root workspace it may expose:

```bash
npm run dev:core -- --host 127.0.0.1 --port 7331 --workspace /absolute/path/to/project
```

Start Desktop in another terminal:

```bash
npm run dev:desktop -- --host 127.0.0.1 --port 7331
```

When both `--host` and `--port` are present, Desktop connects automatically. Without them, it displays the connection screen. The workspace path belongs only to Core and is never supplied to Desktop.

Start Gateway during development with:

```bash
npm run dev:gateway
```

The development launchers compile Electron code, run Vite, and start the corresponding Electron process.

## Build and Run

Build every package in dependency order:

```bash
npm run build
```

Run the compiled backend and Desktop:

```bash
npm run core -- --host 127.0.0.1 --port 7331 --workspace /absolute/path/to/project
npm run desktop -- --host 127.0.0.1 --port 7331
```

Run compiled Gateway:

```bash
npm run gateway
```

`npm run gateway` rebuilds Gateway before launching it. `npm run desktop` uses the existing Desktop build, so run `npm run build` after pulling changes.

## Remote Connections

Core defaults to `127.0.0.1:7331`. Binding to `0.0.0.0` makes it reachable through the host network:

```bash
npm run core -- --host 0.0.0.0 --port 7331 --workspace /srv/projects/example
```

Only do this on a trusted network with an appropriate firewall. Core has no authentication or TLS.

For an SSH tunnel, keep Core bound to loopback on the remote host:

```bash
ssh -N -L 7331:127.0.0.1:7331 user@remote-host
npm run desktop -- --host 127.0.0.1 --port 7331
```

Choose another local port when `7331` is occupied:

```bash
ssh -N -L 8733:127.0.0.1:7331 user@remote-host
npm run desktop -- --host 127.0.0.1 --port 8733
```

When Core runs in WSL and Desktop runs on Windows, try the WSL address or Windows localhost forwarding. If the connection is blocked, bind Core to `0.0.0.0`, allow the selected TCP port through Windows Firewall, or use SSH tunneling. Do not expose the port to the public internet.

## Vibe Gateway

Vibe Gateway automates the SSH workflow:

1. Add one or more SSH connections with host, port, username, and password.
2. Add remote workspaces with a remote directory and preferred Core port.
3. Select **Start server**, **Start client**, or **Stop server**.

Credentials are encrypted with Electron `safeStorage` before being stored in Gateway's application-data directory.

**Start server** connects over SSH, clones or updates the `dev` branch of this repository under `~/.vibe`, and checks the current Git revision against `~/.vibe-build`. Dependencies and Protocol/Core/Desktop artifacts are rebuilt only when the revision changed, required artifacts are missing, or `node_modules` is absent. Core runs on remote loopback with workspace-specific PID and log files. If the preferred port is occupied, Gateway selects an available port and persists it. The Start server button remains disabled while the server is running.

**Start client** reuses platform-independent Desktop JavaScript and renderer artifacts produced on the remote host. Gateway downloads and caches those artifacts by revision, opens a local SSH tunnel, and launches Desktop with Gateway's local Electron runtime. This avoids rebuilding client source on the Windows or macOS client when the cached revision is current. Keep Gateway running because it owns the SSH tunnel.

**Stop server** closes the active tunnel and stops the recorded remote Core process. Gateway checks remote PID files at startup and through the refresh action so workspace cards show current server status.

## Editor

The Project tool window provides a filesystem tree with automatic single-path expansion, file-type icons, Git `M`/`C` indicators, persisted icon colors, recursive Find in Files, and external-change monitoring. Open files autosave after a short pause. Clean open buffers reload after external edits; dirty buffers are preserved with a conflict warning.

Editor tabs support drag-and-drop ordering, middle-click close, Close All, Close All to the Right, and detached editor windows. Modified and created files are marked in the tab strip. Monaco gutter markers show changed blocks without coloring the entire line; selecting a marker opens the previous content and a block rollback action.

Supported highlighting includes TypeScript, JavaScript, JSON, HTML, CSS, XML, Java, Python, YAML, MTA/MTAEXT, SAP CDS, Markdown, and HTTP request files. Settings provide Dark/Light UI themes, Default/Ftpud highlighting, JetBrains Mono or Inter, UI font size, and line height.

## Terminal

The full-width bottom Terminal tool window supports multiple persisted tabs per task workspace. Terminal processes are recreated after reconnect or task switching; terminal dimensions are not persisted.

- `Ctrl+C`/`Cmd+C` copies when text is selected and otherwise reaches the shell.
- `Ctrl+V`/`Cmd+V` pastes through a single sanitized input path.
- Right-click provides Paste.
- `Ctrl`/`Cmd`-click opens HTTP and HTTPS links externally.

Each terminal is a backend PTY rooted in the active workspace. Closing its tab terminates that PTY.

## Git

The Git Changes tool window shows conflicted, untracked, staged, and working-tree changes as a collapsible tree. Single-click opens a split or unified diff; double-click opens the working file. Files and individual change blocks can be rolled back with confirmation.

Select changed files with the checkboxes, enter a commit message in the bottom composer, and select **Commit**. Only the selected paths are staged and committed; unrelated staged changes are excluded. The draft commit message is persisted separately for the root workspace and every task workspace.

The top branch selector groups local and remote branches into expandable `/` path hierarchies. Branch leaves provide Checkout and Rename actions.

The full-width bottom Git tool window provides local and remote branches, a searchable commit history with a visual branch/merge graph and ref labels, changed files, commit diffs, and compare-with-local dialogs. Right-click a branch, commit, or changed file in the log to compare it with the local working state. Editor context menus can show history for a complete file or the current selection.

## Task Workspaces

The Tasks tool window creates isolated Git worktrees under Core's state directory. Creating a task asks for a branch name, creates a linked worktree on that new branch, and carries the root workspace's current staged, unstaged, untracked, ignored, and deleted-file state into it. Existing dependencies are shared through `node_modules` symlinks. Selecting Root workspace returns to the original directory. Deleting a task requires confirmation and removes its worktree and task branch. Legacy copied task workspaces are converted automatically, retaining their commits and working state.

Open files, active tab, terminal tabs, terminal panel state, useful local files, AI sessions, file colors, and Git commit drafts are persisted per task workspace. Task rows show AI state, the latest activity preview, Git additions/deletions, and an animated in-progress indicator.

While a task is active, the Task Git tool window compares its complete working state with the upstream branch recorded when the task was created. The comparison uses the tracked remote upstream when available and otherwise the root workspace's current branch.

Tasks and AI can be open simultaneously in the resizable right sidebar. Tasks appear above AI with a draggable divider; either tool window fills the sidebar when opened alone.

## AI

The AI tool window uses an extensible AI Capability Provider (ACP) layer with Codex CLI and Copilot CLI adapters. Providers declare their available models, reasoning levels, additional controls, usage support, MCP support, and custom-agent support; the UI is generated from those capabilities. Sessions, logs, configuration, and continuation state are persisted per task workspace. Attachment selections are scoped per task while Desktop remains open. See [docs/ACP.md](docs/ACP.md) for the plugin contract and current provider limitations.

Prompts can attach local files or workspace files. Right-click an editor and select **Attach to AI** to add the current file. Execution and command output is collapsed into expandable activity blocks. Task cards show in-progress, waiting-for-user, done, and error states so another task can be used while an AI process continues.

The prompt composer has a full-width panel-style resize handle. **Clear context** starts a fresh provider context without deleting the task workspace.

## Markdown, Useful Files, and HTTP

Markdown opens in rendered mode by default and can switch between Preview and Edit. GitHub-flavored Markdown tables, task lists, links, code, and images are supported. Shell code blocks have Play actions. Re-running the same block reuses that block's terminal; different blocks receive separate terminals.

Useful Files contains editable Global and Local sections with Create, Rename, and Delete actions. Global files are shared by backend workspaces that use the same Core state directory. Local files belong to the active root or task workspace. Useful Markdown files use the same preview and executable-shell behavior as workspace Markdown.

`.http` files support multiple requests separated by `###`. A request contains a method and URL, optional headers, a blank line, and an optional body:

```http
POST https://example.test/api/items
Authorization: Bearer token
Content-Type: application/json

{"name":"example"}

###

GET https://example.test/api/items
Accept: application/json
```

Use the editor gutter Play action to execute a request and inspect status, headers, duration, and response body.

## Java and Maven

Right-click `pom.xml` and select **Load as Maven Project**. Core discovers standard Java source roots and stores Maven project options with the workspace. Additional directories can be marked as source roots from the Project context menu.

JDT LS supplies diagnostics, semantic highlighting, object/method/field/local-variable completion, import edits, declaration navigation, and project usages. `Ctrl/Cmd+Enter` triggers Java completion. `Ctrl/Cmd+click` navigates to declarations; invoking it on a declaration opens usages.

Java run configurations are selected at the top of the application. **Create new...** discovers classes containing `public static void main`. Run, Debug, and Stop use the selected configuration. The Java and Problems bottom tool windows provide Maven build/run output, JDB controls, breakpoints, local variables, compiler diagnostics, and source highlighting.

Maven and a suitable project JDK must be available to Core. The pinned Temurin Java 21 runtime under `.tools/` is used for JDT LS only. Run and Debug use the project's compiled output and local Java tools.

## Persistence

Core stores state outside the project under:

```text
~/.remote-ide/workspaces
```

Set a different location before starting Core:

```bash
REMOTE_IDE_STATE_DIR=/var/lib/vibe-editor npm run core -- --workspace /srv/project
```

State files are keyed by canonical workspace paths. They contain workspace layout options, tasks, useful files, AI session metadata, file colors, terminal restoration data, and Git commit drafts. Project source files remain in their configured workspace or task worktree.

Gateway uses Electron's platform application-data directory, for example `%APPDATA%/Vibe Gateway` on Windows or `~/Library/Application Support/Vibe Gateway` on macOS.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The test suite covers filesystem isolation, workspace state validation, task worktrees and legacy migration, Git parsing/diffs/rollback/selective commits, HTTP execution, Java project behavior, search, and other Core services.

## Security

Core intentionally has no authentication, authorization, or TLS. Anyone who can reach its port can read and modify files inside the configured workspace and execute processes with Core's operating-system permissions. Run it only on loopback, a trusted private network, or through a protected SSH tunnel.

Filesystem operations validate normalized and resolved paths, enforce the configured workspace boundary, and reject parent traversal and symlink escapes. This boundary does not make an unauthenticated public Core deployment safe.

Electron renderers use context isolation, disable Node integration, and expose narrow preload bridges for approved desktop operations.

## Architecture

Each WebSocket client receives services bound to the configured root or selected task workspace. The shared protocol uses correlated typed requests and typed server events for filesystem, terminal, Git, Java, and AI updates. Desktop uses the browser WebSocket API; filesystem paths and process execution remain on Core.

Core watches the active workspace and Git metadata with Chokidar. Changes trigger tree/status refreshes and safe reloads of clean editor buffers. Task switching replaces the active filesystem, workspace-state, Java, terminal, useful-file, and AI context without allowing the client to supply an arbitrary server path.

## License

Vibe Editor is available under the MIT License. See [LICENSE.md](LICENSE.md).
