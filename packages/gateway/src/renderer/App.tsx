import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Cable, CircleStop, HardDrive, Laptop, Network, Pencil, Play, Plus, RefreshCw, Server, Settings, Trash2, X } from "lucide-react";

const emptyState: GatewayState = { connections: [], workspaces: [], portTunnels: [] };

export function App() {
  const [state, setState] = useState(emptyState);
  const [selected, setSelected] = useState<string>();
  const [runtimes, setRuntimes] = useState<Record<string, GatewayRuntime>>({});
  const [tunnelRuntimes, setTunnelRuntimes] = useState<Record<string, GatewayTunnelRuntime>>({});
  const [connectionRuntimes, setConnectionRuntimes] = useState<Record<string, GatewayConnectionRuntime>>({});
  const [repository, setRepository] = useState<GatewayRepositorySettings>();
  const [newTunnelPort, setNewTunnelPort] = useState("");
  const [connectionDialog, setConnectionDialog] = useState<Partial<GatewayConnection> & { password: string; passphrase: string }>();
  const [workspaceDialog, setWorkspaceDialog] = useState<Partial<GatewayWorkspace>>();
  const [repositoryDialog, setRepositoryDialog] = useState<GatewayRepositorySettings>();
  const [error, setError] = useState("");
  const bridgeReady = Boolean(window.gateway);
  useEffect(() => {
    if (!window.gateway) { setError("Gateway preload failed to initialize. Rebuild and restart the application."); return; }
    void window.gateway.get().then((result) => { setState(result.state); setRepository(result.repository); setRuntimes(result.runtimes); setTunnelRuntimes(result.tunnelRuntimes); setConnectionRuntimes(result.connectionRuntimes); setSelected(result.state.connections[0]?.id); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const stopStatusListener = window.gateway.onStatus((id, status) => setRuntimes((current) => ({ ...current, [id]: status })));
    const stopTunnelListener = window.gateway.onTunnelStatus((id, status) => setTunnelRuntimes((current) => ({ ...current, [id]: status })));
    const stopConnectionListener = window.gateway.onConnectionStatus((id, status) => setConnectionRuntimes((current) => ({ ...current, [id]: status })));
    return () => { stopStatusListener(); stopTunnelListener(); stopConnectionListener(); };
  }, []);
  const connection = state.connections.find((item) => item.id === selected);
  const workspaces = useMemo(() => state.workspaces.filter((item) => item.connectionId === selected), [state.workspaces, selected]);
  const connectionTunnels = useMemo(() => state.portTunnels.filter((item) => item.connectionId === selected), [state.portTunnels, selected]);
  const connectionRuntime = connection ? connectionRuntimes[connection.id] ?? { status: "unknown", message: "Not checked yet" } : undefined;

  const action = async (workspace: GatewayWorkspace, operation: "startServer" | "stopServer" | "startClient") => {
    setError("");
    try {
      const result = await window.gateway[operation](workspace.id);
      if (operation === "startServer" && result && "remotePort" in result) setState((current) => ({ ...current, workspaces: current.workspaces.map((item) => item.id === workspace.id ? { ...item, remotePort: result.remotePort } : item) }));
    }
    catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); setRuntimes((current) => ({ ...current, [workspace.id]: { status: "error", message } })); }
  };
  const removeConnection = async (item: GatewayConnection) => { if (confirm(`Delete ${item.name} and its workspaces?`)) { const next = await window.gateway.deleteConnection(item.id); setState(next); setSelected(next.connections[0]?.id); } };
  const removeWorkspace = async (item: GatewayWorkspace) => { if (confirm(`Delete workspace ${item.name}?`)) setState(await window.gateway.deleteWorkspace(item.id)); };
  const addPortTunnel = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection) return;
    const port = Number(newTunnelPort);
    setError("");
    try { setState(await window.gateway.savePortTunnel({ connectionId: connection.id, port })); setNewTunnelPort(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const tunnelAction = async (item: GatewayPortTunnel, operation: "startPortTunnel" | "stopPortTunnel") => {
    setError("");
    try { await window.gateway[operation](item.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const removePortTunnel = async (item: GatewayPortTunnel) => {
    setError("");
    try { setState(await window.gateway.deletePortTunnel(item.id)); setTunnelRuntimes((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="gateway-shell">
    <aside>
      <header><div><Network size={17} /><strong>Connections</strong></div><button title="Add SSH connection" onClick={() => setConnectionDialog({ port: 22, authenticationMethod: "password", password: "", passphrase: "" })}><Plus size={15} /></button></header>
      <div className="connection-list">{state.connections.map((item) => { const current = connectionRuntimes[item.id] ?? { status: "unknown" }; return <button key={item.id} className={item.id === selected ? "selected" : ""} onClick={() => setSelected(item.id)}><div className={`status-dot connection-${current.status}`} /><Server size={16} /><span><strong>{item.name}</strong><small>{item.username}@{item.host}:{item.port}</small></span></button>; })}</div>
    </aside>
    <main>
      <div className="topbar"><div><HardDrive size={18} /><span>Vibe Gateway</span></div><div className="connection-actions">{connection && <><span>{connection.name}</span><span className={`connection-health ${connectionRuntime!.status}`} title={connectionRuntime!.message}>{connectionHealthName(connectionRuntime!.status)}{connectionRuntime!.latencyMs !== undefined && ` · ${connectionRuntime!.latencyMs} ms`}</span><button title="Refresh SSH and Core status" onClick={() => void window.gateway.refreshStatuses(connection.id)}><RefreshCw size={14} /></button><button title="Edit connection" onClick={() => setConnectionDialog({ ...connection, password: "", passphrase: "" })}><Pencil size={14} /></button><button title="Delete connection" onClick={() => void removeConnection(connection)}><Trash2 size={14} /></button></>}<button title="Gateway repository settings" aria-label="Gateway repository settings" onClick={() => repository && setRepositoryDialog(repository)}><Settings size={15} /></button></div></div>
      {!bridgeReady ? <div className="empty"><Network size={38} /><strong>Gateway failed to initialize</strong><span>Close the application and run <code>npm run gateway</code> again.</span></div> : !connection ? <div className="empty"><Network size={38} /><strong>No SSH connections</strong><span>Add a connection to manage remote Vibe Editor workspaces.</span><button onClick={() => setConnectionDialog({ port: 22, authenticationMethod: "password", password: "", passphrase: "" })}><Plus size={15} /> Add connection</button></div> : <section className="workspace-view">
        <header><div><h1>Remote workspaces</h1><p>{connection.username}@{connection.host}</p></div><button onClick={() => setWorkspaceDialog({ connectionId: connection.id, remotePort: 7331 })}><Plus size={15} /> Add workspace</button></header>
        {error && <div className="error-banner">{error}<button onClick={() => setError("")}><X size={14} /></button></div>}
        <div className="workspace-list">{workspaces.map((workspace) => { const current = runtimes[workspace.id] ?? { status: "idle", message: "Not running" }; const busy = current.status === "working"; const serverRunning = current.status === "server" || current.status === "client"; return <article key={workspace.id}>
          <div className="workspace-info"><div className={`status-dot ${current.status}`} /><div><h2>{workspace.name}</h2><code>{workspace.directory}</code><span>Remote port {workspace.remotePort}</span></div><div className="status"><strong>{statusName(current.status)}</strong><small>{current.message}</small></div></div>
          <div className="workspace-buttons"><button title={serverRunning ? "Server is already running" : "Start server"} disabled={busy || serverRunning} onClick={() => void action(workspace, "startServer")}><Play size={14} /> Start server</button><button disabled={busy} onClick={() => void action(workspace, "startClient")}><Laptop size={14} /> Start client</button><button className="stop" disabled={busy} onClick={() => void action(workspace, "stopServer")}><CircleStop size={14} /> Stop server</button><span /><button title="Edit workspace" onClick={() => setWorkspaceDialog(workspace)}><Pencil size={14} /></button><button title="Delete workspace" onClick={() => void removeWorkspace(workspace)}><Trash2 size={14} /></button></div>
        </article>; })}{workspaces.length === 0 && <div className="workspace-empty">No workspaces configured for this connection.</div>}</div>
        <section className="tunnel-section">
          <header><div><Cable size={16} /><div><h2>SSH port tunnels</h2><p>Forward a local port to the same port on {connection.host}.</p></div></div><form onSubmit={(event) => void addPortTunnel(event)}><input aria-label="Tunnel port" required type="number" min="1" max="65535" value={newTunnelPort} onChange={(event) => setNewTunnelPort(event.target.value)} placeholder="Port" /><button className="primary"><Plus size={14} /> Add port</button></form></header>
          <div className="tunnel-list">{connectionTunnels.map((item) => { const current = tunnelRuntimes[item.id] ?? { status: "idle", message: "Stopped" }; const busy = current.status === "working"; const running = current.status === "running"; return <div className="tunnel-row" key={item.id}><div className={`status-dot ${current.status}`} /><div className="tunnel-address"><strong>localhost:{item.port}</strong><small>→ remote localhost:{item.port}</small></div><div className="tunnel-status"><strong>{tunnelStatusName(current.status)}</strong><small>{current.message}</small></div><button disabled={busy || running} onClick={() => void tunnelAction(item, "startPortTunnel")}><Play size={14} /> Run</button><button className="stop" disabled={busy || !running} onClick={() => void tunnelAction(item, "stopPortTunnel")}><CircleStop size={14} /> Stop</button><button title="Delete tunnel" disabled={busy} onClick={() => void removePortTunnel(item)}><Trash2 size={14} /></button></div>; })}{connectionTunnels.length === 0 && <div className="tunnel-empty">No ports configured.</div>}</div>
        </section>
      </section>}
    </main>
    {bridgeReady && connectionDialog && <ConnectionDialog value={connectionDialog} onClose={() => setConnectionDialog(undefined)} onSave={async (value) => { const next = await window.gateway.saveConnection(value); setState(next); setSelected(value.id ?? next.connections.at(-1)?.id); setConnectionDialog(undefined); }} />}
    {bridgeReady && workspaceDialog && connection && <WorkspaceDialog value={workspaceDialog} connectionId={connection.id} onClose={() => setWorkspaceDialog(undefined)} onSave={async (value) => { setState(await window.gateway.saveWorkspace(value)); setWorkspaceDialog(undefined); }} />}
    {bridgeReady && repositoryDialog && <RepositoryDialog value={repositoryDialog} onClose={() => setRepositoryDialog(undefined)} onSave={async (value) => { const saved = await window.gateway.saveRepository(value); setRepository(saved); setRepositoryDialog(undefined); }} />}
  </div>;
}

function RepositoryDialog({ value, onClose, onSave }: { value: GatewayRepositorySettings; onClose(): void; onSave(value: GatewayRepositorySettings): Promise<void> }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await onSave({ repository: form.repository.trim(), branch: form.branch.trim(), autoUpdate: form.autoUpdate }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSaving(false); } };
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>Gateway repository settings</strong><button type="button" onClick={onClose}><X size={15} /></button></header><p className="dialog-help">Gateway clones this source on SSH hosts when starting a server.</p><label>Git repository URL<input required value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })} placeholder="https://github.com/org/repository.git" /></label><label>Branch<input required value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} placeholder="main" /></label><label className="checkbox-field"><input type="checkbox" checked={form.autoUpdate} onChange={(event) => setForm({ ...form, autoUpdate: event.target.checked })} />Automatically fetch and deploy branch updates</label>{error && <div className="form-error">{error}</div>}<footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving..." : "Save settings"}</button></footer></form></div>;
}

function ConnectionDialog({ value, onClose, onSave }: { value: Partial<GatewayConnection> & { password: string; passphrase: string }; onClose(): void; onSave(value: Partial<GatewayConnection> & { name: string; host: string; port: number; username: string; authenticationMethod: "password" | "privateKey"; password?: string; passphrase?: string }): Promise<void> }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [error, setError] = useState(""); const [testResult, setTestResult] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await onSave({ ...form, name: form.name!.trim(), host: form.host!.trim(), port: Number(form.port), username: form.username!.trim(), authenticationMethod: form.authenticationMethod ?? "password", password: form.password, passphrase: form.passphrase }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSaving(false); } };
  const chooseKey = async () => { setError(""); try { const privateKeyPath = await window.gateway.pickPrivateKey(); if (privateKeyPath) setForm({ ...form, privateKeyPath }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const testConnection = async () => { setTesting(true); setError(""); setTestResult(""); try { const result = await window.gateway.testConnection({ id: form.id, host: form.host?.trim() ?? "", port: Number(form.port), username: form.username?.trim() ?? "", authenticationMethod: form.authenticationMethod ?? "password", password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase }); setTestResult(result.message); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setTesting(false); } };
  const keyAuthentication = form.authenticationMethod === "privateKey";
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>{form.id ? "Edit SSH connection" : "New SSH connection"}</strong><button type="button" onClick={onClose} disabled={testing}><X size={15} /></button></header><label>Name<input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production server" /></label><div className="field-row"><label>Host<input required value={form.host ?? ""} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.50" /></label><label className="port">Port<input required type="number" min="1" max="65535" value={form.port ?? 22} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label></div><label>Username<input required value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Authentication<select value={form.authenticationMethod ?? "password"} onChange={(e) => setForm({ ...form, authenticationMethod: e.target.value as "password" | "privateKey" })}><option value="password">Password</option><option value="privateKey">Private key</option></select></label>{keyAuthentication ? <><label>Private key file<div className="file-picker"><input required value={form.privateKeyPath ?? ""} onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })} placeholder="/Users/me/.ssh/id_ed25519" /><button type="button" onClick={() => void chooseKey()} disabled={testing}>Choose…</button></div></label><label>Key passphrase<input type="password" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} placeholder={form.id ? "Leave blank to keep saved passphrase" : "Optional"} /></label></> : <label>Password<input required={!form.id} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? "Leave blank to keep saved password" : "SSH password"} /></label>}{testResult && <div className="form-success">{testResult}</div>}{error && <div className="form-error">{error}</div>}<footer><button type="button" onClick={onClose} disabled={testing}>Cancel</button><button type="button" onClick={() => void testConnection()} disabled={saving || testing}>{testing ? "Testing..." : "Test connection"}</button><button className="primary" disabled={saving || testing}>{saving ? "Saving..." : "Save connection"}</button></footer></form></div>;
}

function WorkspaceDialog({ value, connectionId, onClose, onSave }: { value: Partial<GatewayWorkspace>; connectionId: string; onClose(): void; onSave(value: Partial<GatewayWorkspace> & { connectionId: string; name: string; directory: string; remotePort: number }): Promise<void> }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false); const [discovering, setDiscovering] = useState(false); const [directories, setDirectories] = useState<string[]>([]); const [error, setError] = useState("");
  const discover = async () => { setDiscovering(true); setError(""); try { setDirectories(await window.gateway.discoverWorkspaceDirectories(connectionId)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setDiscovering(false); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await onSave({ ...form, connectionId, name: form.name!.trim(), directory: form.directory!.trim(), remotePort: Number(form.remotePort) }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSaving(false); } };
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>{form.id ? "Edit remote workspace" : "New remote workspace"}</strong><button type="button" onClick={onClose} disabled={saving || discovering}><X size={15} /></button></header><label>Name<input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Backend API" /></label><label>Remote directory<input required list="workspace-directories" value={form.directory ?? ""} onChange={(e) => setForm({ ...form, directory: e.target.value })} placeholder="/home/user/projects/api" /><datalist id="workspace-directories">{directories.map((directory) => <option key={directory} value={directory} />)}</datalist></label><button className="discover-workspaces" type="button" onClick={() => void discover()} disabled={saving || discovering}>{discovering ? "Discovering…" : "Discover folders"}</button><p className="dialog-help">Lists direct folders in common project locations under the remote SSH user’s home. You can still enter an absolute path manually; it will be checked before saving.</p><label>Core port<input required type="number" min="1024" max="65535" value={form.remotePort ?? 7331} onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} /></label>{error && <div className="form-error">{error}</div>}<footer><button type="button" onClick={onClose} disabled={saving || discovering}>Cancel</button><button className="primary" disabled={saving || discovering}>{saving ? "Saving..." : "Save workspace"}</button></footer></form></div>;
}

function statusName(status: GatewayRuntime["status"]): string { return { idle: "Stopped", working: "In progress", server: "Server ready", client: "Client running", error: "Failed" }[status]; }
function tunnelStatusName(status: GatewayTunnelRuntime["status"]): string { return { idle: "Stopped", working: "Connecting", running: "Running", error: "Failed" }[status]; }
function connectionHealthName(status: GatewayConnectionRuntime["status"]): string { return { unknown: "SSH unchecked", reconnecting: "SSH reconnecting", online: "SSH online", slow: "SSH slow", offline: "SSH offline" }[status]; }
