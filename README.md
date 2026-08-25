# Vibe Editor

A minimal remote IDE split into two independently running processes:

- `core`: a Node.js WebSocket backend that exposes a selected remote workspace and PTY processes.
- `desktop`: an Electron + React application with an Explorer, file tabs, Monaco Editor, and terminal panel.
- `protocol`: shared TypeScript request, response, error, and DTO definitions.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Setup and development

```bash
npm install
```

Start the backend in one terminal and give it the only workspace it may expose:

```bash
npm run dev:core -- --host 0.0.0.0 --port 7331 --workspace /absolute/path/to/project
```

Start Electron and its Vite development server in another terminal:

```bash
npm run dev:desktop
```

Enter the backend host and port, then select **Connect**. The connection details are retained locally, but the application never reconnects automatically.

Host and port can also be supplied when launching the development desktop. When both are present, the desktop connects automatically:

```bash
npm run dev:desktop -- --host 192.168.1.50 --port 7331
```

To run the compiled backend instead:

```bash
npm run build
npm run core -- --host 0.0.0.0 --port 7331 --workspace /absolute/path/to/project
npm run desktop -- --host 192.168.1.50 --port 7331
```

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Backend tests cover opening valid and missing workspaces, tree construction, reading, writing, parent traversal, absolute paths, symlink escapes, and the 2 MB size limit.

## Architecture

The backend validates its configured workspace before listening. Each WebSocket connection owns a separate `WorkspaceFileSystem` session bound to that same configured root; clients cannot select another root. Requests use a small typed request/response protocol with correlation IDs. Filesystem resolution is isolated from WebSocket handling and checks both normalized paths and resolved real paths. Symbolic links cannot escape the workspace.

The renderer uses the browser's native WebSocket API. This keeps the POC transport simple without exposing Node.js to untrusted renderer content. Electron runs with `contextIsolation: true`, `nodeIntegration: false`, and web security enabled. The preload bridge exposes only `setDirtyState(boolean)`, which lets the main process show a native warning before closing a window with unsaved tabs.

The UI state separates layout panels, editor groups, and file tabs in `model.ts`. The POC renders one explorer panel and one editor group, while the model can be extended with more groups and tab content types later. Files are read on demand and are not mirrored locally.

The backend watches the configured workspace and broadcasts typed change events. The desktop refreshes Explorer automatically and reloads externally changed files that are open and clean. If an open file has unsaved edits, its buffer is preserved and an external-change warning is shown instead. Files deleted outside the editor remain open with a deletion warning.

## Vibe Gateway

Vibe Gateway is a separate Electron application for managing Vibe Editor over SSH. Start it from a built checkout with `npm run gateway`, or use `npm run dev:gateway` during development. SSH passwords are encrypted with Electron `safeStorage` before they are written to Gateway's application-data directory.

Each saved SSH connection can contain multiple remote workspaces. **Start server** clones or updates the `dev` branch of `https://github.com/ftpud/VibeEditor` under `~/.vibe` on the SSH host, installs dependencies, builds Protocol and Core, then starts Core on remote loopback with a workspace-specific PID and log file. The SSH account therefore needs Git, Node.js 20+, npm, and access to the configured workspace directory.

**Start client** downloads the platform-independent compiled Desktop artifacts from the remote build over SFTP, caches them by Git commit under Gateway's local application-data directory, opens a loopback SSH tunnel, and launches them with Gateway's local Electron runtime. It does not download source, install npm packages, or compile on the client machine. **Stop server** closes Gateway's active tunnel and stops the recorded remote Core process. Keep Gateway running while using a client it launched because Gateway owns the tunnel.

The Git tool-window button switches the left sidebar from Project to Git Changes. It shows the current branch and groups conflicted, untracked, staged, modified, deleted, and renamed paths. Status refreshes on workspace changes and Git index updates. Git integration is read-only; staging, reverting, and committing are not included.

Selecting a file in Git Changes opens a separate read-only diff tab comparing `HEAD` with the current workspace content. The tab toolbar switches Monaco between side-by-side and unified layouts. New files use an empty original side, and deleted files use an empty modified side. Diff tabs refresh when their file or Git index changes and are intentionally not included in restored editable-file sessions.

Markdown file tabs include Edit and Preview controls. Preview mode renders GitHub-flavored Markdown with tables, task lists, code blocks, links, and responsive images. Raw HTML is not rendered.

## Java and Maven

Java editing uses a pinned Eclipse JDT Language Server and a private Temurin Java 21 runtime under `.tools/`. `npm install` attempts to download and checksum-verify both, but a download failure does not prevent desktop-only installations. Run `npm run install:jdtls` on the backend machine to install or repair them. This runtime is only used by the language server and does not replace the JDK used by Maven, Run, or Debug.

Normal completion and `Ctrl/Cmd+Enter` provide semantic types, methods, fields, and local variables. Completion edits supplied by JDT LS also insert imports. `Ctrl/Cmd+click` navigates to a declaration; using it on the declaration itself opens the project usages list.

Right-click a `pom.xml` in Project and select **Load as Maven Project**. Core parses the POM, records Maven metadata in the persisted workspace JSON, detects existing main/test Java source directories, and enables the Java tool windows. The saved options include the POM path, Maven executable, source roots, and main/test output paths.

Right-click a folder after Maven loading and select **Mark as Sources Root** to add generated or nonstandard Java sources. The Java sidebar presents source roots as compact Java package trees rather than filesystem folders. Selecting a Java class opens it in the regular editor.

The full-width Java bottom tool window contains Build, Run, Debug, Stop, and Clear controls plus streamed process output. Choose **Create new...** in the top run-configuration selector to create a profile. Core discovers classes containing `public static void main`, and the dialog lets you select one and assign a profile name. Profiles and the selected profile persist with the workspace; Maven re-import preserves them.

Build runs `mvn -f <pom> package -DskipTests`; Run executes `mvn -f <pom> exec:java -Dexec.mainClass=<selected-class>`. The Maven Exec Plugin must be available to the project. Only one Java build or run process is active per client session, and disconnecting stops it. Maven and an appropriate JDK must be installed on the backend machine and available to the backend process.

Core persists the ordered open-file list and active file for each canonical workspace. State is stored outside the project under `~/.remote-ide/workspaces`, keyed by a hash of the workspace path, so it does not create Git changes. Reconnecting reloads the saved tabs and restores the active tab. Set `REMOTE_IDE_STATE_DIR` on the backend to use a different state directory.

Right-click a file or directory in Project and select **Find in Files** to search recursively from that scope. Right-clicking a file searches its containing directory; right-clicking the workspace root searches the whole workspace. Search supports optional case matching, skips binary and oversized files, and returns at most 500 matches. Selecting a result opens the file and moves Monaco to its exact line and column.

The terminal button in the top-right toolbar creates a PTY shell in a resizable panel below the editor. The plus button creates additional terminal tabs. Each tab has an independent shell, terminal size, scrollback buffer, and lifecycle. Closing a terminal tab kills its remote process, and disconnecting closes every terminal owned by that client session.

## POC limits and security

There is deliberately no authentication or TLS. **Do not expose the core backend to the public internet.** Run it only on localhost, a trusted LAN, or through a protected tunnel. Anyone who can reach the port can read and modify files in the configured workspace and execute shell commands with the backend process's operating-system permissions.

This POC does not include language servers, Git integration, search, plugins, collaboration, docking, or filesystem mutation beyond writing existing files.

## Manual end-to-end check

1. Start `core` and `desktop` using the commands above.
2. Enter the backend host and port in the desktop connection screen and connect.
3. Expand folders and open multiple text files; clicking an open file activates its existing tab.
4. Edit a file, verify its dirty marker, and save with the toolbar button or `Ctrl+S`/`Cmd+S`.
5. Close and reopen the file to confirm the backend saved it.
6. Drag the divider to resize Explorer and use its refresh button to reload the tree.
7. Modify a file and close its tab or the application to verify the unsaved-change warning.
8. Use the terminal toolbar button to open the bottom panel, create multiple terminal tabs, run commands, resize the panel, and close each tab.
