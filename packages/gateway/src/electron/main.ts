import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ConnectConfig } from "ssh2";

type Connection = { id: string; name: string; host: string; port: number; username: string; password: string };
type Workspace = { id: string; connectionId: string; name: string; directory: string; remotePort: number };
type StoredConnection = Omit<Connection, "password"> & { password: string };
type State = { connections: StoredConnection[]; workspaces: Workspace[] };
type PublicState = { connections: Omit<Connection, "password">[]; workspaces: Workspace[] };
type Runtime = { status: "idle" | "working" | "server" | "client" | "error"; message: string };

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = "https://github.com/ftpud/VibeEditor";
const remoteNodeEnvironment = `export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.fnm:$HOME/.nvm/versions/node/current/bin:/usr/local/bin:$PATH"; export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi; command -v npm >/dev/null 2>&1 || { echo "npm was not found on the SSH host. Install Node.js 20+ for this user or configure NVM in ~/.bashrc." >&2; exit 127; }`;
const runtimes = new Map<string, Runtime>();
const tunnels = new Map<string, { ssh: Client; server: Server }>();

app.name = "Vibe Gateway";
app.setAppUserModelId("com.vibe-editor.gateway");

function stateFile(): string { return path.join(app.getPath("userData"), "gateway.json"); }
async function readState(): Promise<State> {
  try { return JSON.parse(await readFile(stateFile(), "utf8")) as State; }
  catch { return { connections: [], workspaces: [] }; }
}
async function saveState(state: State): Promise<void> {
  await mkdir(path.dirname(stateFile()), { recursive: true });
  await writeFile(stateFile(), JSON.stringify(state, null, 2), "utf8");
}
function encrypt(password: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system");
  return safeStorage.encryptString(password).toString("base64");
}
function decrypt(password: string): string { return safeStorage.decryptString(Buffer.from(password, "base64")); }
function publicState(state: State): PublicState {
  return { connections: state.connections.map(({ password: _password, ...item }) => item), workspaces: state.workspaces };
}
function id(): string { return crypto.randomUUID(); }
function shell(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function runtime(workspaceId: string, status: Runtime["status"], message: string): void {
  const value = { status, message }; runtimes.set(workspaceId, value);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("gateway:status", workspaceId, value);
}
async function credentials(connectionId: string): Promise<Connection> {
  const item = (await readState()).connections.find((connection) => connection.id === connectionId);
  if (!item) throw new Error("SSH connection was not found");
  return { ...item, password: decrypt(item.password) };
}
function connect(connection: Connection): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const config: ConnectConfig = { host: connection.host, port: connection.port, username: connection.username, password: connection.password, readyTimeout: 20_000, keepaliveInterval: 10_000 };
    client.once("ready", () => resolve(client)).once("error", reject).connect(config);
  });
}
function execute(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let stdout = ""; let stderr = "";
    stream.on("data", (data: Buffer) => { stdout += data.toString(); });
    stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    stream.on("close", (code: number) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || stdout.trim() || `Remote command exited with ${code}`)));
  }));
}
async function withWorkspace(workspaceId: string): Promise<{ workspace: Workspace; connection: Connection }> {
  const state = await readState(); const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("Workspace was not found");
  return { workspace, connection: await credentials(workspace.connectionId) };
}
async function refreshStatuses(connectionId?: string): Promise<void> {
  const state = await readState();
  const workspaces = state.workspaces.filter((workspace) => !connectionId || workspace.connectionId === connectionId);
  for (const workspace of workspaces) runtime(workspace.id, "working", "Checking remote server...");
  const groups = new Map<string, Workspace[]>();
  for (const workspace of workspaces) groups.set(workspace.connectionId, [...(groups.get(workspace.connectionId) ?? []), workspace]);
  await Promise.all([...groups.entries()].map(async ([currentConnectionId, items]) => {
    let client: Client | undefined;
    try {
      client = await connect(await credentials(currentConnectionId));
      for (const workspace of items) {
        const pidFile = `~/.vibe-server-${workspace.id}.pid`;
        const result = (await execute(client, `bash -lc ${shell(`if [ -f ${pidFile} ] && kill -0 $(cat ${pidFile}) 2>/dev/null; then echo running; else rm -f ${pidFile}; echo stopped; fi`)}`)).trim();
        runtime(workspace.id, result === "running" ? "server" : "idle", result === "running" ? `Server listening remotely on ${workspace.remotePort}` : "Stopped");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const workspace of items) runtime(workspace.id, "error", `Status check failed: ${message}`);
    } finally { client?.end(); }
  }));
}
async function provision(client: Client): Promise<{ commit: string; rebuilt: boolean }> {
  const command = `set -e; ${remoteNodeEnvironment}; if [ -d ~/.vibe/.git ]; then git -C ~/.vibe pull --ff-only; else rm -rf ~/.vibe; git clone ${repository} ~/.vibe; fi; cd ~/.vibe; head=$(git rev-parse HEAD); rebuilt=0; if [ ! -f ~/.vibe-core-build ] || [ "$(cat ~/.vibe-core-build)" != "$head" ] || [ ! -f packages/core/dist/index.js ] || [ ! -d node_modules ]; then VIBE_SKIP_JDTLS=1 npm install; npm run build -w @remote-ide/protocol; npm run build -w @remote-ide/core; printf '%s' "$head" > ~/.vibe-core-build; rebuilt=1; fi; printf '\nVIBE_RESULT:%s:%s\n' "$head" "$rebuilt"`;
  const output = await execute(client, `bash -lc ${shell(command)}`);
  const match = output.match(/VIBE_RESULT:([0-9a-f]{40,64}):([01])/);
  if (!match?.[1]) throw new Error("Remote Git revision could not be determined");
  return { commit: match[1], rebuilt: match[2] === "1" };
}
async function startServer(workspaceId: string): Promise<{ remotePort: number }> {
  const { workspace, connection } = await withWorkspace(workspaceId); runtime(workspaceId, "working", "Updating and building remote server...");
  const client = await connect(connection);
  try {
    const build = await provision(client);
    const portScript = `const net=require("net");const preferred=${workspace.remotePort};let fallback=false;const open=port=>{const server=net.createServer();server.unref();server.once("error",error=>{if(error.code==="EADDRINUSE"&&!fallback){fallback=true;open(0);return}throw error});server.listen(port,"127.0.0.1",()=>{console.log(server.address().port);server.close()})};open(preferred)`;
    const selectedPort = Number((await execute(client, `bash -lc ${shell(`${remoteNodeEnvironment}; node -e ${shell(portScript)}`)}`)).trim());
    if (!Number.isInteger(selectedPort) || selectedPort < 1) throw new Error("Could not allocate a remote Core port");
    if (selectedPort !== workspace.remotePort) {
      const state = await readState(); state.workspaces = state.workspaces.map((item) => item.id === workspace.id ? { ...item, remotePort: selectedPort } : item); await saveState(state);
      workspace.remotePort = selectedPort;
    }
    const pidFile = `~/.vibe-server-${workspace.id}.pid`; const logFile = `~/.vibe-server-${workspace.id}.log`;
    const run = `set -e; ${remoteNodeEnvironment}; if [ -f ${pidFile} ]; then kill $(cat ${pidFile}) 2>/dev/null || true; rm -f ${pidFile}; fi; cd ~/.vibe; nohup node packages/core/dist/index.js --host 127.0.0.1 --port ${workspace.remotePort} --workspace ${shell(workspace.directory)} > ${logFile} 2>&1 < /dev/null & echo $! > ${pidFile}; sleep 2; if ! kill -0 $(cat ${pidFile}) 2>/dev/null; then echo "Core failed to start. Remote log:" >&2; tail -n 40 ${logFile} >&2; rm -f ${pidFile}; exit 1; fi`;
    await execute(client, `bash -lc ${shell(run)}`); runtime(workspaceId, "server", `Server listening remotely on ${workspace.remotePort}${build.rebuilt ? " (rebuilt)" : " (build reused)"}`);
    return { remotePort: workspace.remotePort };
  } finally { client.end(); }
}
async function stopServer(workspaceId: string): Promise<void> {
  const { workspace, connection } = await withWorkspace(workspaceId); runtime(workspaceId, "working", "Stopping remote server...");
  tunnels.get(workspaceId)?.server.close(); tunnels.get(workspaceId)?.ssh.end(); tunnels.delete(workspaceId);
  const client = await connect(connection);
  try { await execute(client, `bash -lc ${shell(`if [ -f ~/.vibe-server-${workspace.id}.pid ]; then kill $(cat ~/.vibe-server-${workspace.id}.pid) 2>/dev/null || true; rm -f ~/.vibe-server-${workspace.id}.pid; fi`)}`); }
  finally { client.end(); }
  runtime(workspaceId, "idle", "Stopped");
}
async function download(client: Client, remote: string, local: string): Promise<void> {
  await new Promise<void>((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : sftp.fastGet(remote, local, (failure) => failure ? reject(failure) : resolve())));
}
function runLocal(command: string, args: string[], cwd: string, env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    let executable = command; let commandArgs = args;
    if (process.platform === "win32" && command === "tar") executable = "tar.exe";
    if (process.platform === "win32" && command === "npm") {
      const npmCli = process.env.npm_execpath; const node = process.env.npm_node_execpath;
      if (npmCli && node) { executable = node; commandArgs = [npmCli, ...args]; }
      else { executable = process.env.ComSpec ?? "cmd.exe"; commandArgs = ["/d", "/s", "/c", "npm", ...args]; }
    }
    const child = spawn(executable, commandArgs, { cwd, env, stdio: "inherit", shell: false });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${executable} exited with ${code}`)));
  });
}
async function createTunnel(workspaceId: string, connection: Connection, remotePort: number): Promise<number> {
  tunnels.get(workspaceId)?.server.close(); tunnels.get(workspaceId)?.ssh.end();
  const ssh = await connect(connection);
  const server = createServer((socket) => ssh.forwardOut("127.0.0.1", socket.remotePort ?? 0, "127.0.0.1", remotePort, (error, stream) => {
    if (error) { socket.destroy(error); return; } socket.pipe(stream).pipe(socket);
  }));
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  tunnels.set(workspaceId, { ssh, server });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not allocate local tunnel port");
  return address.port;
}
async function startClient(workspaceId: string): Promise<void> {
  const { workspace, connection } = await withWorkspace(workspaceId); runtime(workspaceId, "working", "Downloading client source...");
  const client = await connect(connection);
  const commit = (await execute(client, `git -C ~/.vibe rev-parse HEAD`)).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) { client.end(); throw new Error("Remote Vibe checkout was not found. Start the server first."); }
  const clientRoot = path.join(app.getPath("userData"), "clients", workspace.id, commit); const archive = path.join(app.getPath("temp"), `vibe-${workspace.id}-${commit}.tar.gz`);
  const buildMarker = path.join(clientRoot, ".gateway-client-built");
  let clientBuilt = false;
  try { clientBuilt = (await readFile(buildMarker, "utf8")).trim() === commit; await access(path.join(clientRoot, "packages", "desktop", "dist-electron", "main.js")); await access(path.join(clientRoot, "packages", "desktop", "dist-renderer", "index.html")); }
  catch { clientBuilt = false; }
  if (!clientBuilt) {
  try {
    await execute(client, `bash -lc ${shell(`cd ~/.vibe; tar --exclude=.git --exclude=node_modules --exclude=.tools --exclude=dist --exclude=dist-electron --exclude=dist-renderer -czf /tmp/vibe-${workspace.id}.tar.gz .`)}`);
    await mkdir(path.dirname(archive), { recursive: true }); await download(client, `/tmp/vibe-${workspace.id}.tar.gz`, archive);
    await execute(client, `rm -f /tmp/vibe-${workspace.id}.tar.gz`);
  } finally { client.end(); }
    await mkdir(clientRoot, { recursive: true });
    runtime(workspaceId, "working", "Building local client...");
    await runLocal("tar", ["-xzf", archive, "-C", clientRoot], clientRoot); await rm(archive, { force: true });
    await runLocal("npm", ["install"], clientRoot, { ...process.env, VIBE_SKIP_JDTLS: "1" });
    await runLocal("npm", ["run", "build", "-w", "@remote-ide/protocol"], clientRoot);
    await runLocal("npm", ["run", "build", "-w", "@remote-ide/desktop"], clientRoot);
    await writeFile(buildMarker, `${commit}\n`, "utf8");
  } else { client.end(); runtime(workspaceId, "working", "Reusing local client build..."); }
  const localPort = await createTunnel(workspaceId, connection, workspace.remotePort);
  const desktopRoot = path.join(clientRoot, "packages", "desktop");
  const desktopMain = path.join(desktopRoot, "dist-electron", "main.js");
  const child = spawn(process.execPath, [desktopMain, "--host", "127.0.0.1", "--port", String(localPort)], { cwd: desktopRoot, env: { ...process.env, VITE_DEV_SERVER_URL: "" }, detached: true, stdio: "ignore" });
  child.unref(); runtime(workspaceId, "client", `Client connected through local port ${localPort}${clientBuilt ? " (build reused)" : " (rebuilt)"}`);
}

ipcMain.handle("gateway:get", async () => {
  const state = await readState();
  setTimeout(() => { void refreshStatuses(); }, 0);
  return { state: publicState(state), runtimes: Object.fromEntries(runtimes) };
});
ipcMain.handle("gateway:refreshStatuses", (_event, connectionId?: string) => refreshStatuses(connectionId));
ipcMain.handle("gateway:saveConnection", async (_event, input: Omit<Connection, "id"> & { id?: string }) => {
  const state = await readState(); const existing = input.id ? state.connections.find((item) => item.id === input.id) : undefined;
  const item: StoredConnection = { id: input.id ?? id(), name: input.name, host: input.host, port: input.port, username: input.username, password: input.password ? encrypt(input.password) : existing?.password ?? "" };
  if (!item.password) throw new Error("Password is required"); state.connections = [...state.connections.filter((value) => value.id !== item.id), item]; await saveState(state); return publicState(state);
});
ipcMain.handle("gateway:deleteConnection", async (_event, connectionId: string) => { const state = await readState(); state.connections = state.connections.filter((item) => item.id !== connectionId); state.workspaces = state.workspaces.filter((item) => item.connectionId !== connectionId); await saveState(state); return publicState(state); });
ipcMain.handle("gateway:saveWorkspace", async (_event, input: Omit<Workspace, "id"> & { id?: string }) => { const state = await readState(); const item = { ...input, id: input.id ?? id() } as Workspace; state.workspaces = [...state.workspaces.filter((value) => value.id !== item.id), item]; await saveState(state); return publicState(state); });
ipcMain.handle("gateway:deleteWorkspace", async (_event, workspaceId: string) => { const state = await readState(); state.workspaces = state.workspaces.filter((item) => item.id !== workspaceId); await saveState(state); return publicState(state); });
ipcMain.handle("gateway:startServer", (_event, workspaceId: string) => startServer(workspaceId));
ipcMain.handle("gateway:stopServer", (_event, workspaceId: string) => stopServer(workspaceId));
ipcMain.handle("gateway:startClient", (_event, workspaceId: string) => startClient(workspaceId));

function createWindow(): void {
  const window = new BrowserWindow({ width: 1040, height: 720, minWidth: 820, minHeight: 560, backgroundColor: "#202124", webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  window.removeMenu(); const devUrl = process.env.VITE_DEV_SERVER_URL;
  void (devUrl ? window.loadURL(devUrl) : window.loadFile(path.join(directory, "../dist-renderer/index.html")));
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => { for (const tunnel of tunnels.values()) { tunnel.server.close(); tunnel.ssh.end(); } if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
