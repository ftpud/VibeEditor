# Vibe Editor — Features

Vibe Editor is a remote-workspace IDE: an Electron/React/Monaco desktop client talking over WebSockets to a Node.js backend ("Core") that owns the filesystem, terminal, Git, Java, and AI operations. This document lists the features actually implemented in the codebase.

## Architecture

- **`@remote-ide/core`** — workspace-scoped WebSocket backend; owns filesystem, terminal, Git, Java, HTTP, and AI operations for a single root workspace.
- **`@remote-ide/desktop`** — Electron/React/Monaco client; connects to Core via `--host`/`--port` and renders all IDE tool windows.
- **`@remote-ide/gateway`** — separate Electron app that manages SSH connections, starts/stops a remote Core, tunnels the port, and launches Desktop against it.
- **`@remote-ide/protocol`** — shared TypeScript request/response/event/DTO types used by Core and Desktop.
- **`@remote-ide/acp`** — the "AI Capability Provider" contract (types only) implemented by AI provider adapters.
- Each connected client is bound to a root or task workspace; Core watches files and Git metadata with Chokidar and pushes safe reloads/refresh events over the shared protocol.

## Editor

- Monaco-based code editor with a diff editor and detached (pop-out) editor windows.
- Filesystem tree (Project tool window) with automatic single-path expansion, file-type icons, persisted per-file icon colors, Git `M`/`C` status indicators, and external-change monitoring.
- Recursive **Find in Files** search across the workspace.
- Tabs support drag-and-drop reordering, middle-click close, Close All, Close All to the Right, and modified/created markers.
- Autosave after a short pause; clean buffers reload automatically on external edits, dirty buffers keep a conflict warning instead of being overwritten.
- Monaco gutter markers highlight changed blocks (not whole lines); clicking a marker shows previous content and offers a block-level rollback.
- Syntax highlighting for TypeScript, JavaScript, JSON, HTML, CSS, XML, Java, Python, YAML, MTA/MTAEXT, SAP CDS, Markdown, and `.http` files.
- Settings: Dark/Light UI theme, Default/Ftpud syntax highlighting theme, JetBrains Mono or Inter font, adjustable UI font size and line height.

## Terminal

- Bottom Terminal tool window with multiple persisted tabs per task workspace, backed by real PTYs on Core (`node-pty`).
- Terminal processes are recreated after reconnect or task switching (dimensions are not persisted).
- Copy-on-selection / paste via `Ctrl`/`Cmd`+C/V, right-click Paste, and `Ctrl`/`Cmd`-click to open HTTP(S) links externally.
- Closing a terminal tab terminates its backend PTY.

## Git

- Git Changes tool window: collapsible tree of conflicted, untracked, staged, and working-tree changes; single-click split/unified diff, double-click opens the file.
- Rollback of whole files or individual change blocks (with confirmation).
- Selective staged commits — checkbox-select files, write a message in the composer, commit only the selected paths (drafts persisted per root/task workspace).
- Branch selector grouping local/remote branches into expandable path hierarchies, with Checkout and Rename actions.
- Bottom Git tool window: searchable commit history with a visual branch/merge graph, ref labels, changed-file lists, commit diffs, and "compare with local working state" for branches/commits/files.
- Editor context menu can show Git history for a whole file or the current selection.
- Cherry-pick, per-file history, compare-with-ref, and diff-stat support in the backend Git service.

## Task Workspaces

- Isolated task Git worktrees created under Core's state directory, each on its own new branch; legacy workspace copies are migrated automatically without losing commits or working changes.
- Per-task persistence of open files, active tab, terminal tabs/panel state, useful local files, AI sessions, file colors, and Git commit drafts.
- Task Git tool window compares a task's full working state against its recorded upstream (or the root workspace's branch).
- Task list shows AI state, latest activity preview, Git additions/deletions, and an in-progress indicator; Tasks and AI panels can share the resizable right sidebar with a draggable divider.

## AI Integration

- Pluggable **AI Capability Provider (ACP)** layer with adapters for the **Codex CLI** and **GitHub Copilot CLI**.
- Providers declare supported models, reasoning levels, extra controls, usage reporting, MCP server support, and custom-agent support; the AI panel UI is generated from those capabilities.
- Global and per-workspace agent presets with editable Markdown templates, automatic `.agents` discovery, and a persisted per-task agent selector.
- Searchable model picker showing each model's request-cost multiplier, context window, description, reasoning levels, input modalities, and availability as advertised by the agent.
- Session send/interrupt/steer/clear, usage display, and MCP server injection.
- Sessions, logs, configuration, and continuation state persisted per task workspace; "Clear context" starts a fresh provider context without deleting the task workspace.
- Attach local or workspace files to a prompt, including "Attach to AI" from the editor's right-click menu.
- Long-running execution/output is collapsed into expandable activity blocks; task cards show in-progress, waiting-for-user, done, and error states.
- **Vibe MCP tools**: built-in `vibe-editor` MCP server exposes tools for creating/listing/deleting task worktrees, starting task agents, appending prompts to running conversations, reading recent responses, and setting or replacing the current task's multiline commit-message draft without creating a commit. Enabled when an agent preset lists MCP servers.

## Java & Maven

- "Load as Maven Project" on `pom.xml`; automatic discovery of standard Java source roots, plus manual source-root marking from the Project context menu.
- JDT Language Server integration: diagnostics, semantic highlighting, completion (objects/methods/fields/local variables), import edits, go-to-declaration, and find-usages.
- Java run configuration discovery (classes with `public static void main`), plus Run/Debug/Stop actions.
- Debugging via `jdb`: breakpoints, stepping, local variable inspection.
- Java and Problems tool windows show Maven build/run output, debugger controls, and compiler diagnostics.
- A pinned Temurin Java 21 runtime (under `.tools/`) is bundled specifically to run JDT LS.

## Markdown, Useful Files & HTTP

- Markdown opens rendered by default, toggleable between Preview and Edit; supports GitHub-flavored tables, task lists, links, code, and images.
- Executable shell code blocks ("Play" action) — re-running the same block reuses its terminal, different blocks get separate terminals.
- "Useful Files": editable Global (shared across workspaces using the same Core state directory) and Local (per root/task workspace) file collections with Create/Rename/Delete.
- `.http` request files: multiple `###`-separated requests, each with method/URL, headers, and optional body; gutter "Play" action executes a request and shows status, headers, duration, and response body.

## Vibe Gateway (Remote Workflow)

- Add/edit/delete SSH connections (host, port, username, password) and remote workspace definitions (remote directory + preferred Core port).
- Credentials encrypted at rest via Electron `safeStorage`.
- **Start server**: connects over SSH, clones/updates the `dev` branch under `~/.vibe`, rebuilds dependencies/artifacts only when the Git revision changed or artifacts are missing, runs Core on remote loopback with per-workspace PID/log files, and auto-selects a free port if the preferred one is taken.
- **Start client**: reuses cached prebuilt Desktop JS/renderer artifacts from the remote host, opens an SSH tunnel, and launches Desktop locally against the tunneled port.
- **Stop server**: closes the tunnel and stops the tracked remote Core process; workspace cards poll and display live server status.

## Persistence

- Core persists workspace layout, tasks, useful files, AI session metadata, file colors, terminal restoration data, and Git commit drafts outside the project, under `~/.remote-ide/workspaces` (overridable via `REMOTE_IDE_STATE_DIR`).
- Desktop persists client-side UI preferences (tool window visibility, side panel widths, stacked panel sizes, bottom panel heights, layout mode, theme, fonts) per remote workspace in `settings.json` inside its Electron application-data directory, so panel geometry survives client restarts.
- Gateway stores its own connection/workspace data in the platform's Electron application-data directory.

## Security Model

- Core has **no built-in authentication, authorization, or TLS** — it's designed to run on loopback or behind an SSH tunnel/trusted network only.
- Filesystem operations enforce workspace-boundary checks: normalized/resolved paths, rejection of parent-directory traversal and symlink escapes.
- Electron renderers use context isolation, disable Node integration, and expose only narrow preload bridges.
