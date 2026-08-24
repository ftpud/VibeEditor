# Remote IDE POC

A minimal remote IDE split into two independently running processes:

- `core`: a Node.js WebSocket backend that exposes a selected remote workspace.
- `desktop`: an Electron + React application with an Explorer, file tabs, and Monaco Editor.
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

## POC limits and security

There is deliberately no authentication or TLS. **Do not expose the core backend to the public internet.** Run it only on localhost, a trusted LAN, or through a protected tunnel. Anyone who can reach the port can read and modify existing files inside the backend's configured workspace.

This POC does not include terminals, process execution, language servers, Git, search, plugins, collaboration, file watching, docking, or filesystem mutation beyond writing existing files. `ProcessManager` is an intentionally empty boundary for future terminal/process work.

## Manual end-to-end check

1. Start `core` and `desktop` using the commands above.
2. Enter the backend host and port in the desktop connection screen and connect.
3. Expand folders and open multiple text files; clicking an open file activates its existing tab.
4. Edit a file, verify its dirty marker, and save with the toolbar button or `Ctrl+S`/`Cmd+S`.
5. Close and reopen the file to confirm the backend saved it.
6. Drag the divider to resize Explorer and use its refresh button to reload the tree.
7. Modify a file and close its tab or the application to verify the unsaved-change warning.
