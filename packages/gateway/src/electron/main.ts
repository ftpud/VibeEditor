import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";
import { connectionHealthForLatency, type ConnectionRuntime } from "./connection-health.js";
import { connectionConfig, normalizeStoredAuthentication, sshConnectionError, testSshConnection, validatePrivateKey, validatePrivateKeyPath, type AuthenticationMethod, type ConnectionAuth, type ConnectionDetails } from "./connection-auth.js";
import { defaultRepositorySettings, normalizeRepositorySettings, provisionCommand, repositorySettingsOrDefault, type RepositorySettings } from "./repository-settings.js";
import { parseDiscoveredWorkspaceDirectories, parseValidatedWorkspaceDirectory, validateWorkspaceDirectoryInput, workspaceDiscoveryCommand, workspaceValidationCommand } from "./workspace-path.js";
import { compatibleClient, readCompatibility, type Compatibility } from "./client-compatibility.js";
import { boundedProvisioningLog, classifyProvisioningFailure } from "./provisioning.js";

type Connection = { id: string; name: string; host: string; port: number; username: string } & ConnectionAuth;
type Workspace = { id: string; connectionId: string; name: string; directory: string; remotePort: number };
type PortTunnel = { id: string; connectionId: string; port: number };
type StoredConnection = { id: string; name: string; host: string; port: number; username: string; authenticationMethod?: AuthenticationMethod; password: string; privateKeyPath?: string; passphrase?: string };
type State = { connections: StoredConnection[]; workspaces: Workspace[]; portTunnels: PortTunnel[]; repository: RepositorySettings };
type PublicState = { connections: { id: string; name: string; host: string; port: number; username: string; authenticationMethod: AuthenticationMethod; privateKeyPath?: string }[]; workspaces: Workspace[]; portTunnels: PortTunnel[] };
type Runtime = { status: "idle" | "working" | "server" | "client" | "error"; message: string; logs?: string[]; retryable?: boolean; repairable?: boolean };
type TunnelRuntime = { status: "idle" | "working" | "running" | "error"; message: string };

const directory = path.dirname(fileURLToPath(import.meta.url));
const appIcon = path.join(directory, "../assets/app-icon.png");
const remoteNodeEnvironment = `export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.fnm:$HOME/.nvm/versions/node/current/bin:/usr/local/bin:$PATH"; export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi; command -v npm >/dev/null 2>&1 || { echo "npm was not found on the SSH host. Install Node.js 20+ for this user or configure NVM in ~/.bashrc." >&2; exit 127; }`;
const runtimes = new Map<string, Runtime>();
const tunnels = new Map<string, { ssh: Client; server: Server }>();
const portTunnelRuntimes = new Map<string, TunnelRuntime>();
const portTunnels = new Map<string, { ssh: Client; server: Server }>();
const connectionRuntimes = new Map<string, ConnectionRuntime>();
const provisioningClients = new Map<string, Client>();
const cancelledProvisioning = new Set<string>();

app.name = "Vibe Gateway";
app.setName("Vibe Gateway");
app.setAppUserModelId("com.vibe-editor.gateway");
process.title = "Vibe Gateway";
app.commandLine.appendSwitch("class", "VibeGateway");

function stateFile(): string { return path.join(app.getPath("userData"), "gateway.json"); }
async function readState(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<State>;
    return { connections: (state.connections ?? []).map(normalizeStoredAuthentication), workspaces: state.workspaces ?? [], portTunnels: state.portTunnels ?? [], repository: repositorySettingsOrDefault(state.repository) };
  }
  catch { return { connections: [], workspaces: [], portTunnels: [], repository: defaultRepositorySettings }; }
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
  return { connections: state.connections.map((connection) => { const item = normalizeStoredAuthentication(connection); return { id: item.id, name: item.name, host: item.host, port: item.port, username: item.username, authenticationMethod: item.authenticationMethod, ...(item.privateKeyPath ? { privateKeyPath: item.privateKeyPath } : {}) }; }), workspaces: state.workspaces, portTunnels: state.portTunnels };
}
function id(): string { return crypto.randomUUID(); }
function shell(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function runtime(workspaceId: string, status: Runtime["status"], message: string, details: Omit<Runtime, "status" | "message"> = {}): void {
  const value = { status, message, ...details }; runtimes.set(workspaceId, value);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("gateway:status", workspaceId, value);
}
function portTunnelRuntime(tunnelId: string, status: TunnelRuntime["status"], message: string): void {
  const value = { status, message }; portTunnelRuntimes.set(tunnelId, value);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("gateway:tunnelStatus", tunnelId, value);
}
function connectionRuntime(connectionId: string, value: ConnectionRuntime): void {
  connectionRuntimes.set(connectionId, value);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("gateway:connectionStatus", connectionId, value);
}
async function credentials(connectionId: string): Promise<Connection> {
  const item = (await readState()).connections.find((connection) => connection.id === connectionId);
  if (!item) throw new Error("SSH connection was not found");
  const normalized = normalizeStoredAuthentication(item);
  if (normalized.authenticationMethod === "privateKey") return { ...normalized, authenticationMethod: "privateKey", privateKeyPath: normalized.privateKeyPath ?? "", ...(normalized.passphrase ? { passphrase: decrypt(normalized.passphrase) } : {}) };
  return { ...normalized, authenticationMethod: "password", password: decrypt(normalized.password) };
}
function connectWithConfig(config: Parameters<Client["connect"]>[0]): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client)).once("error", (error) => reject(sshConnectionError(error, config.privateKey ? "privateKey" : "password"))).connect(config);
  });
}
async function connect(connection: ConnectionDetails): Promise<Client> { return connectWithConfig(await connectionConfig(connection, readFile)); }
function execute(client: Client, command: string, onOutput?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let stdout = ""; let stderr = "";
    let pending = "";
    const receive = (data: Buffer) => { const text = data.toString(); stdout += text; pending += text; const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ""; for (const line of lines) onOutput?.(line); };
    stream.on("data", receive);
    stream.stderr.on("data", receive);
    stream.on("close", (code: number) => {
      if (code === 0) { resolve(stdout); return; }
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      reject(new Error(output || `Remote command exited with ${code}`));
    });
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
    const previous = connectionRuntimes.get(currentConnectionId);
    connectionRuntime(currentConnectionId, { status: "reconnecting", message: previous?.status === "offline" ? "Reconnecting to SSH host..." : "Checking SSH connection..." });
    try {
      const startedAt = performance.now();
      client = await connect(await credentials(currentConnectionId));
      const latencyMs = Math.round(performance.now() - startedAt);
      connectionRuntime(currentConnectionId, connectionHealthForLatency(latencyMs));
      for (const workspace of items) {
        const pidFile = `~/.vibe-server-${workspace.id}.pid`;
        const result = (await execute(client, `bash -lc ${shell(`if [ -f ${pidFile} ] && kill -0 $(cat ${pidFile}) 2>/dev/null; then echo running; else rm -f ${pidFile}; echo stopped; fi`)}`)).trim();
        runtime(workspace.id, result === "running" ? "server" : "idle", result === "running" ? `Server listening remotely on ${workspace.remotePort}` : "Stopped");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connectionRuntime(currentConnectionId, { status: "offline", message: `SSH unavailable: ${message}` });
      for (const workspace of items) runtime(workspace.id, "error", `Status check failed: ${message}`);
    } finally { client?.end(); }
  }));
}
async function provision(workspaceId: string, client: Client, settings: RepositorySettings, repair = false): Promise<{ commit: string; rebuilt: boolean }> {
  const command = provisionCommand(settings, remoteNodeEnvironment, repair);
  const logs: string[] = [];
  const output = await execute(client, `bash -lc ${shell(command)}`, (line) => {
    logs.push(line);
    const stage = line.match(/^VIBE_STAGE:(.+)$/)?.[1];
    runtime(workspaceId, "working", stage ? `${stage.replaceAll("-", " ")}…` : "Provisioning remote Vibe application…", { logs: boundedProvisioningLog(logs) });
  });
  if (cancelledProvisioning.has(workspaceId)) throw new Error("Provisioning cancelled");
  const match = output.match(/VIBE_RESULT:([0-9a-f]{40,64}):([01])/);
  if (!match?.[1]) throw new Error("Remote Git revision could not be determined");
  return { commit: match[1], rebuilt: match[2] === "1" };
}
async function startServer(workspaceId: string, repair = false): Promise<{ remotePort: number }> {
  const { workspace, connection } = await withWorkspace(workspaceId); runtime(workspaceId, "working", "Updating and building remote server...");
  const client = await connect(connection); provisioningClients.set(workspaceId, client); cancelledProvisioning.delete(workspaceId);
  try {
    const build = await provision(workspaceId, client, (await readState()).repository, repair);
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
  } catch (error) {
    const failure = classifyProvisioningFailure(cancelledProvisioning.has(workspaceId) ? new Error("Provisioning cancelled") : error);
    runtime(workspaceId, "error", failure.message, { logs: runtimes.get(workspaceId)?.logs, retryable: failure.retryable, repairable: failure.repairable });
    throw error;
  } finally { provisioningClients.delete(workspaceId); cancelledProvisioning.delete(workspaceId); client.end(); }
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
    let executable = command;
    if (process.platform === "win32" && command === "tar") executable = "tar.exe";
    const child = spawn(executable, args, { cwd, env, stdio: "inherit", shell: false });
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
async function startPortTunnel(tunnelId: string): Promise<void> {
  const state = await readState();
  const tunnel = state.portTunnels.find((item) => item.id === tunnelId);
  if (!tunnel) throw new Error("Port tunnel was not found");
  if (!Number.isInteger(tunnel.port) || tunnel.port < 1 || tunnel.port > 65535) throw new Error("Tunnel port must be between 1 and 65535");
  portTunnelRuntime(tunnelId, "working", "Connecting over SSH...");
  stopPortTunnel(tunnelId, false);
  let ssh: Client | undefined;
  try {
    ssh = await connect(await credentials(tunnel.connectionId));
    const server = createServer((socket) => ssh!.forwardOut("127.0.0.1", socket.remotePort ?? 0, "127.0.0.1", tunnel.port, (error, stream) => {
      if (error) { socket.destroy(error); return; }
      socket.pipe(stream).pipe(socket);
    }));
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(tunnel.port, "127.0.0.1", resolve));
    portTunnels.set(tunnelId, { ssh, server });
    server.on("error", (error) => {
      if (portTunnels.has(tunnelId)) portTunnelRuntime(tunnelId, "error", error.message);
    });
    ssh.on("close", () => {
      if (portTunnels.delete(tunnelId)) {
        server.close();
        portTunnelRuntime(tunnelId, "error", "SSH connection closed");
      }
    });
    portTunnelRuntime(tunnelId, "running", `127.0.0.1:${tunnel.port} → remote 127.0.0.1:${tunnel.port}`);
  } catch (error) {
    ssh?.end();
    const message = error instanceof Error ? error.message : String(error);
    portTunnelRuntime(tunnelId, "error", message);
    throw error;
  }
}
function stopPortTunnel(tunnelId: string, notify = true): void {
  const active = portTunnels.get(tunnelId);
  portTunnels.delete(tunnelId);
  active?.server.close();
  active?.ssh.end();
  if (notify) portTunnelRuntime(tunnelId, "idle", "Stopped");
}
async function startClient(workspaceId: string): Promise<void> {
  const { workspace, connection } = await withWorkspace(workspaceId); runtime(workspaceId, "working", "Checking remote client build...");
  const client = await connect(connection);
  const commit = (await execute(client, `git -C ~/.vibe rev-parse HEAD`)).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) { client.end(); throw new Error("Remote Vibe checkout was not found. Start the server first."); }
  const remoteCompatibilityOutput = await execute(client, `bash -lc ${shell(`${remoteNodeEnvironment}; cd ~/.vibe; node --input-type=module -e ${shell("import { protocolCompatibility } from './packages/protocol/dist/index.js'; console.log(JSON.stringify(protocolCompatibility))")}`)}`);
  const remoteCompatibility = JSON.parse(remoteCompatibilityOutput) as Compatibility;
  if (!compatibleClient(remoteCompatibility, remoteCompatibility)) { client.end(); throw new Error("Remote Core reported an invalid protocol compatibility range"); }
  const clientsDirectory = path.join(app.getPath("userData"), "clients", workspace.id);
  const clientRoot = path.join(clientsDirectory, commit); const archive = path.join(app.getPath("temp"), `vibe-${workspace.id}-${commit}.tar.gz`);
  const buildMarker = path.join(clientRoot, ".gateway-client-built");
  const expectedMarker = `artifact-v1:${commit}`;
  let clientBuilt = false;
  try {
    const marker = (await readFile(buildMarker, "utf8")).trim();
    clientBuilt = marker === expectedMarker || marker === commit;
    await access(path.join(clientRoot, "package.json")); await access(path.join(clientRoot, "compatibility.json")); await access(path.join(clientRoot, "dist-electron", "main.js")); await access(path.join(clientRoot, "dist-renderer", "index.html"));
    const compatibility = readCompatibility(JSON.parse(await readFile(path.join(clientRoot, "compatibility.json"), "utf8")));
    clientBuilt = clientBuilt && !!compatibility && compatibleClient(compatibility, remoteCompatibility);
    if (clientBuilt && marker !== expectedMarker) await writeFile(buildMarker, `${expectedMarker}\n`, "utf8");
  }
  catch { clientBuilt = false; }
  if (!clientBuilt) {
    const cached = await readdir(clientsDirectory, { withFileTypes: true }).catch(() => []);
    const rollback = (await Promise.all(cached.filter((entry) => entry.isDirectory() && entry.name !== commit).map(async (entry) => {
      const candidate = path.join(clientsDirectory, entry.name);
      try {
        const marker = (await readFile(path.join(candidate, ".gateway-client-built"), "utf8")).trim();
        const compatibility = readCompatibility(JSON.parse(await readFile(path.join(candidate, "compatibility.json"), "utf8")));
        await access(path.join(candidate, "dist-electron", "main.js")); await access(path.join(candidate, "dist-renderer", "index.html"));
        return marker.startsWith("artifact-v1:") && compatibility && compatibleClient(compatibility, remoteCompatibility) ? candidate : undefined;
      } catch { return undefined; }
    }))).find(Boolean);
    if (rollback) {
      const choice = await dialog.showMessageBox({ type: "warning", buttons: ["Download update", "Use last known-good client", "Cancel"], defaultId: 0, cancelId: 2, title: "Desktop update available", message: "The cached Desktop cannot be used with this Core.", detail: "Choose a verified update or keep using the last compatible client." });
      if (choice.response === 1) { client.end(); await launchClient(workspaceId, workspace, connection, rollback, true); return; }
      if (choice.response === 2) { client.end(); throw new Error("Desktop update was cancelled"); }
    }
  }
  if (!clientBuilt) {
  try {
    const remoteArchive = `/tmp/vibe-${workspace.id}.tar.gz`;
    const checksum = (await execute(client, `bash -lc ${shell(`set -e; test -f ~/.vibe/packages/desktop/compatibility.json; cd ~/.vibe/packages/desktop; files="package.json compatibility.json dist-electron dist-renderer"; if [ -d assets ]; then files="$files assets"; fi; tar -czf ${remoteArchive} $files; sha256sum ${remoteArchive}`)}`)).trim().split(/\s+/)[0];
    await mkdir(path.dirname(archive), { recursive: true }); await download(client, `/tmp/vibe-${workspace.id}.tar.gz`, archive);
    const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (actual !== checksum) throw new Error("Downloaded Desktop artifacts failed checksum verification");
    await execute(client, `rm -f ${remoteArchive}`);
  } finally { client.end(); }
    await mkdir(clientRoot, { recursive: true });
    runtime(workspaceId, "working", "Installing remote-built client artifacts...");
    await runLocal("tar", ["-xzf", archive, "-C", clientRoot], clientRoot); await rm(archive, { force: true });
    const downloadedCompatibility = readCompatibility(JSON.parse(await readFile(path.join(clientRoot, "compatibility.json"), "utf8")));
    if (!downloadedCompatibility || !compatibleClient(downloadedCompatibility, remoteCompatibility)) throw new Error("Downloaded Desktop is not compatible with the remote Core");
    await writeFile(buildMarker, `${expectedMarker}\n`, "utf8");
  } else { client.end(); runtime(workspaceId, "working", "Reusing local client build..."); }
  await launchClient(workspaceId, workspace, connection, clientRoot, clientBuilt);
}
async function launchClient(workspaceId: string, workspace: Workspace, connection: Connection, clientRoot: string, clientBuilt: boolean): Promise<void> {
  const localIcon = process.env.VIBE_DESKTOP_ICON;
  if (localIcon) {
    await mkdir(path.join(clientRoot, "assets"), { recursive: true });
    try { await access(path.join(clientRoot, "assets", "app-icon.png")); }
    catch { await copyFile(localIcon, path.join(clientRoot, "assets", "app-icon.png")); }
  }
  const localPort = await createTunnel(workspaceId, connection, workspace.remotePort);
  const desktopMain = path.join(clientRoot, "dist-electron", "main.js");
  const desktopExecutable = process.env.VIBE_DESKTOP_EXECUTABLE || process.execPath;
  const child = spawn(desktopExecutable, [desktopMain, "--host", "127.0.0.1", "--port", String(localPort)], { cwd: clientRoot, env: { ...process.env, VITE_DEV_SERVER_URL: "" }, detached: true, stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new Error(`Could not launch Vibe Editor using ${desktopExecutable}: ${error.message}`)));
    });
  } catch (error) {
    tunnels.get(workspaceId)?.server.close(); tunnels.get(workspaceId)?.ssh.end(); tunnels.delete(workspaceId);
    throw error;
  }
  child.unref(); runtime(workspaceId, "client", `Client connected through local port ${localPort}${clientBuilt ? " (artifacts reused)" : " (artifacts downloaded)"}`);
}

ipcMain.handle("gateway:get", async () => {
  const state = await readState();
  setTimeout(() => { void refreshStatuses(); }, 0);
  return { state: publicState(state), repository: state.repository, runtimes: Object.fromEntries(runtimes), tunnelRuntimes: Object.fromEntries(portTunnelRuntimes), connectionRuntimes: Object.fromEntries(connectionRuntimes) };
});
ipcMain.handle("gateway:saveRepository", async (_event, input: Partial<RepositorySettings>) => { if (!input.repository?.trim() || !input.branch?.trim()) throw new Error("Repository URL and branch are required"); const state = await readState(); state.repository = normalizeRepositorySettings(input); await saveState(state); return state.repository; });
ipcMain.handle("gateway:refreshStatuses", (_event, connectionId?: string) => refreshStatuses(connectionId));
ipcMain.handle("gateway:pickPrivateKey", async () => {
  const selected = await dialog.showOpenDialog({ title: "Choose SSH private key", properties: ["openFile"], filters: [{ name: "SSH private keys", extensions: ["pem", "key", "ppk"] }, { name: "All files", extensions: ["*"] }] });
  if (selected.canceled || !selected.filePaths[0]) return undefined;
  const selectedPath = selected.filePaths[0];
  validatePrivateKeyPath(selectedPath);
  let key: Buffer;
  try { key = await readFile(selectedPath); }
  catch { throw new Error(`Could not read the private key file at ${selectedPath}`); }
  try { validatePrivateKey(key); }
  catch (error) {
    // A passphrase is entered in the form after selecting an encrypted key.
    if (!(error instanceof Error) || !/requires its passphrase/.test(error.message)) throw error;
  }
  return selectedPath;
});
ipcMain.handle("gateway:testConnection", async (_event, input: { id?: string; host: string; port: number; username: string; authenticationMethod: AuthenticationMethod; password?: string; privateKeyPath?: string; passphrase?: string }) => {
  const authenticationMethod = input.authenticationMethod === "privateKey" ? "privateKey" : "password";
  if (!input.host.trim() || !input.username.trim() || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Host, username, and a valid SSH port are required");
  const existing = input.id ? (await readState()).connections.find((item) => item.id === input.id) : undefined;
  const saved = existing && normalizeStoredAuthentication(existing).authenticationMethod === authenticationMethod ? await credentials(input.id!) : undefined;
  const connection = authenticationMethod === "privateKey"
    ? { host: input.host.trim(), port: input.port, username: input.username.trim(), authenticationMethod, privateKeyPath: input.privateKeyPath?.trim() || (saved?.authenticationMethod === "privateKey" ? saved.privateKeyPath : ""), ...(input.passphrase ? { passphrase: input.passphrase } : saved?.authenticationMethod === "privateKey" && saved.passphrase ? { passphrase: saved.passphrase } : {}) } as const
    : { host: input.host.trim(), port: input.port, username: input.username.trim(), authenticationMethod, password: input.password || (saved?.authenticationMethod === "password" ? saved.password : "") } as const;
  if (authenticationMethod === "password" && !connection.password) throw new Error("Password is required");
  await testSshConnection(await connectionConfig(connection, readFile), connectWithConfig);
  return { message: "SSH connection succeeded" };
});
ipcMain.handle("gateway:saveConnection", async (_event, input: { id?: string; name: string; host: string; port: number; username: string; authenticationMethod: AuthenticationMethod; password?: string; privateKeyPath?: string; passphrase?: string }) => {
  const state = await readState(); const existing = input.id ? state.connections.find((item) => item.id === input.id) : undefined;
  const item: StoredConnection = { id: input.id ?? id(), name: input.name, host: input.host, port: input.port, username: input.username, authenticationMethod: input.authenticationMethod, password: "" };
  if (input.authenticationMethod === "password") { item.password = input.password ? encrypt(input.password) : existing?.authenticationMethod !== "privateKey" ? existing?.password ?? "" : ""; if (!item.password) throw new Error("Password is required"); }
  else { item.privateKeyPath = input.privateKeyPath?.trim() || (existing?.authenticationMethod === "privateKey" ? existing.privateKeyPath : ""); if (!item.privateKeyPath) throw new Error("A private key file is required for key authentication"); validatePrivateKeyPath(item.privateKeyPath); let key: Buffer; try { key = await readFile(item.privateKeyPath); } catch { throw new Error(`Could not read the private key file at ${item.privateKeyPath}`); } validatePrivateKey(key, input.passphrase || (existing?.authenticationMethod === "privateKey" && existing.passphrase ? decrypt(existing.passphrase) : undefined)); item.passphrase = input.passphrase ? encrypt(input.passphrase) : existing?.authenticationMethod === "privateKey" ? existing.passphrase : undefined; }
  state.connections = [...state.connections.filter((value) => value.id !== item.id), item]; await saveState(state); return publicState(state);
});
ipcMain.handle("gateway:deleteConnection", async (_event, connectionId: string) => { const state = await readState(); for (const tunnel of state.portTunnels.filter((item) => item.connectionId === connectionId)) stopPortTunnel(tunnel.id, false); state.connections = state.connections.filter((item) => item.id !== connectionId); state.workspaces = state.workspaces.filter((item) => item.connectionId !== connectionId); state.portTunnels = state.portTunnels.filter((item) => item.connectionId !== connectionId); await saveState(state); return publicState(state); });
ipcMain.handle("gateway:discoverWorkspaceDirectories", async (_event, connectionId: string) => {
  const client = await connect(await credentials(connectionId));
  try { return parseDiscoveredWorkspaceDirectories(await execute(client, workspaceDiscoveryCommand())); }
  finally { client.end(); }
});
ipcMain.handle("gateway:saveWorkspace", async (_event, input: Omit<Workspace, "id"> & { id?: string }) => {
  const directory = validateWorkspaceDirectoryInput(input.directory);
  if (!input.name.trim()) throw new Error("Workspace name is required");
  if (!Number.isInteger(input.remotePort) || input.remotePort < 1024 || input.remotePort > 65535) throw new Error("Core port must be between 1024 and 65535");
  const state = await readState();
  if (!state.connections.some((item) => item.id === input.connectionId)) throw new Error("SSH connection was not found");
  const client = await connect(await credentials(input.connectionId));
  let validatedDirectory: string;
  try { validatedDirectory = parseValidatedWorkspaceDirectory(await execute(client, workspaceValidationCommand(directory))); }
  finally { client.end(); }
  const item = { ...input, name: input.name.trim(), directory: validatedDirectory, id: input.id ?? id() } as Workspace;
  state.workspaces = [...state.workspaces.filter((value) => value.id !== item.id), item]; await saveState(state); return publicState(state);
});
ipcMain.handle("gateway:deleteWorkspace", async (_event, workspaceId: string) => { const state = await readState(); state.workspaces = state.workspaces.filter((item) => item.id !== workspaceId); await saveState(state); return publicState(state); });
ipcMain.handle("gateway:savePortTunnel", async (_event, input: Omit<PortTunnel, "id"> & { id?: string }) => { if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Tunnel port must be between 1 and 65535"); const state = await readState(); if (!state.connections.some((item) => item.id === input.connectionId)) throw new Error("SSH connection was not found"); const item = { ...input, id: input.id ?? id() } as PortTunnel; if (state.portTunnels.some((value) => value.id !== item.id && value.connectionId === item.connectionId && value.port === item.port)) throw new Error(`Port ${item.port} is already configured for this connection`); if (input.id) stopPortTunnel(input.id, false); state.portTunnels = [...state.portTunnels.filter((value) => value.id !== item.id), item]; await saveState(state); return publicState(state); });
ipcMain.handle("gateway:deletePortTunnel", async (_event, tunnelId: string) => { stopPortTunnel(tunnelId, false); const state = await readState(); state.portTunnels = state.portTunnels.filter((item) => item.id !== tunnelId); await saveState(state); portTunnelRuntimes.delete(tunnelId); return publicState(state); });
ipcMain.handle("gateway:startPortTunnel", (_event, tunnelId: string) => startPortTunnel(tunnelId));
ipcMain.handle("gateway:stopPortTunnel", (_event, tunnelId: string) => stopPortTunnel(tunnelId));
ipcMain.handle("gateway:startServer", (_event, workspaceId: string) => startServer(workspaceId));
ipcMain.handle("gateway:repairServer", (_event, workspaceId: string) => startServer(workspaceId, true));
ipcMain.handle("gateway:cancelProvisioning", (_event, workspaceId: string) => { cancelledProvisioning.add(workspaceId); provisioningClients.get(workspaceId)?.end(); runtime(workspaceId, "idle", "Provisioning cancelled"); });
ipcMain.handle("gateway:stopServer", (_event, workspaceId: string) => stopServer(workspaceId));
ipcMain.handle("gateway:startClient", (_event, workspaceId: string) => startClient(workspaceId));

function createWindow(): void {
  const window = new BrowserWindow({ width: 1040, height: 720, minWidth: 820, minHeight: 560, icon: appIcon, backgroundColor: "#202124", webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  window.removeMenu(); const devUrl = process.env.VITE_DEV_SERVER_URL;
  void (devUrl ? window.loadURL(devUrl) : window.loadFile(path.join(directory, "../dist-renderer/index.html")));
}
app.whenReady().then(() => {
  app.setName("Vibe Gateway"); process.title = "Vibe Gateway";
  if (process.platform === "darwin") app.dock.setIcon(nativeImage.createFromPath(appIcon));
  createWindow();
});
app.on("window-all-closed", () => { for (const tunnel of tunnels.values()) { tunnel.server.close(); tunnel.ssh.end(); } for (const tunnel of portTunnels.values()) { tunnel.server.close(); tunnel.ssh.end(); } if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
