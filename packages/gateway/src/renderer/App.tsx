import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Cable, Check, CircleStop, Copy, HardDrive, Laptop, Network, Pencil, Play, Plus, RefreshCw, Search, Server, Settings, Trash2, X } from "lucide-react";

const emptyState: GatewayState = { connections: [], workspaces: [], portTunnels: [] };

export function gatewayErrorMessage(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Gateway action failed";
  const message = raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\b(password|passphrase|token|secret|authorization)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return "Gateway action failed";
  return message.length <= 320 ? message : `${message.slice(0, 319).trimEnd()}…`;
}

export function GatewayErrorNotice({ message, onDismiss }: { message: string; onDismiss(): void }) {
  return <div className="gateway-status-float" role="alert" aria-live="assertive" aria-atomic="true"><span>{message}</span><button title="Dismiss error" aria-label="Dismiss error" onClick={onDismiss}><X size={14} /></button></div>;
}

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
  const [discoverWorkspaceOnOpen, setDiscoverWorkspaceOnOpen] = useState(false);
  const [repositoryDialog, setRepositoryDialog] = useState<GatewayRepositorySettings>();
  const [error, setError] = useState("");
  const errorRef = useRef("");
  const showError = useCallback((reason: unknown, prefix = "") => {
    const message = gatewayErrorMessage(`${prefix}${gatewayErrorMessage(reason)}`);
    if (message === errorRef.current) return;
    errorRef.current = message;
    setError(message);
  }, []);
  const clearError = useCallback(() => { errorRef.current = ""; setError(""); }, []);
  const bridgeReady = Boolean(window.gateway);
  useEffect(() => {
    if (!window.gateway) { showError("Gateway preload failed to initialize. Rebuild and restart the application."); return; }
    void window.gateway.get().then((result) => { setState(result.state); setRepository(result.repository); setRuntimes(result.runtimes); setTunnelRuntimes(result.tunnelRuntimes); setConnectionRuntimes(result.connectionRuntimes); setSelected(result.state.connections[0]?.id); }).catch(showError);
    const stopStatusListener = window.gateway.onStatus((id, status) => setRuntimes((current) => ({ ...current, [id]: status })));
    const stopTunnelListener = window.gateway.onTunnelStatus((id, status) => setTunnelRuntimes((current) => ({ ...current, [id]: status })));
    const stopConnectionListener = window.gateway.onConnectionStatus((id, status) => setConnectionRuntimes((current) => ({ ...current, [id]: status })));
    const onWindowError = (event: ErrorEvent) => showError(event.error ?? event.message, "Unexpected Gateway error: ");
    const onUnhandledRejection = (event: PromiseRejectionEvent) => { event.preventDefault(); showError(event.reason, "Unexpected Gateway error: "); };
    window.addEventListener("error", onWindowError); window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => { stopStatusListener(); stopTunnelListener(); stopConnectionListener(); window.removeEventListener("error", onWindowError); window.removeEventListener("unhandledrejection", onUnhandledRejection); };
  }, [showError]);
  const connection = state.connections.find((item) => item.id === selected);
  const workspaces = useMemo(() => state.workspaces.filter((item) => item.connectionId === selected), [state.workspaces, selected]);
  const connectionTunnels = useMemo(() => state.portTunnels.filter((item) => item.connectionId === selected), [state.portTunnels, selected]);
  const connectionRuntime = connection ? connectionRuntimes[connection.id] ?? { status: "unknown", message: "Not checked yet" } : undefined;

  const action = async (workspace: GatewayWorkspace, operation: "startServer" | "repairServer" | "stopServer" | "startClient") => {
    clearError();
    try {
      const result = await window.gateway[operation](workspace.id);
      if ((operation === "startServer" || operation === "repairServer") && result && "remotePort" in result) setState((current) => ({ ...current, workspaces: current.workspaces.map((item) => item.id === workspace.id ? { ...item, remotePort: result.remotePort } : item) }));
    }
    catch (reason) { showError(reason); }
  };
  const removeConnection = async (item: GatewayConnection) => { if (!confirm(`Delete ${item.name} and its workspaces?`)) return; clearError(); try { const next = await window.gateway.deleteConnection(item.id); setState(next); setSelected(next.connections[0]?.id); } catch (reason) { showError(reason); } };
  const removeWorkspace = async (item: GatewayWorkspace) => { if (!confirm(`Delete workspace ${item.name}?`)) return; clearError(); try { setState(await window.gateway.deleteWorkspace(item.id)); } catch (reason) { showError(reason); } };
  const refreshConnection = async (connectionId: string) => { clearError(); try { await window.gateway.refreshStatuses(connectionId); } catch (reason) { showError(reason); } };
  const cancelProvisioning = async (workspaceId: string) => { clearError(); try { await window.gateway.cancelProvisioning(workspaceId); } catch (reason) { showError(reason); } };
  const addPortTunnel = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection) return;
    const port = Number(newTunnelPort);
    clearError();
    try { setState(await window.gateway.savePortTunnel({ connectionId: connection.id, port })); setNewTunnelPort(""); }
    catch (reason) { showError(reason); }
  };
  const tunnelAction = async (item: GatewayPortTunnel, operation: "startPortTunnel" | "stopPortTunnel") => {
    clearError();
    try { await window.gateway[operation](item.id); }
    catch (reason) { showError(reason); }
  };
  const removePortTunnel = async (item: GatewayPortTunnel) => {
    clearError();
    try { setState(await window.gateway.deletePortTunnel(item.id)); setTunnelRuntimes((current) => { const next = { ...current }; delete next[item.id]; return next; }); }
    catch (reason) { showError(reason); }
  };

  return <div className="gateway-shell">
    <aside>
      <header><div><Network size={17} /><strong>Connections</strong></div><button title="Add SSH connection" aria-label="Add SSH connection" onClick={() => { clearError(); setConnectionDialog({ port: 22, authenticationMethod: "password", password: "", passphrase: "" }); }}><Plus size={15} /></button></header>
      <div className="connection-list" aria-label="SSH connections">{state.connections.map((item) => { const current = connectionRuntimes[item.id] ?? { status: "unknown" }; return <button key={item.id} className={item.id === selected ? "selected" : ""} aria-pressed={item.id === selected} aria-label={`${item.name}, ${connectionHealthName(current.status)}, ${item.username} at ${item.host}, port ${item.port}`} onClick={() => { clearError(); setSelected(item.id); }}><div className={`status-dot connection-${current.status}`} aria-hidden="true" /><Server size={16} /><span><strong>{item.name}</strong><small>{item.username}@{item.host}:{item.port}</small></span></button>; })}</div>
    </aside>
    <main>
      <div className="topbar"><div><HardDrive size={18} /><span>Vibe Gateway</span></div><div className="connection-actions">{connection && <><span>{connection.name}</span><span className={`connection-health ${connectionRuntime!.status}`} title={connectionRuntime!.message} role="status" aria-live="polite">{connectionHealthName(connectionRuntime!.status)}{connectionRuntime!.latencyMs !== undefined && ` · ${connectionRuntime!.latencyMs} ms`}</span><button title="Refresh SSH and Core status" aria-label="Refresh SSH and Core status" onClick={() => void refreshConnection(connection.id)}><RefreshCw size={14} /></button><DiagnosticsCopyButton onCopy={() => window.gateway.copyDiagnostics(connection.id)} onFailure={(reason) => showError(reason, "Could not copy diagnostics: ")} /><button title="Edit connection" aria-label={`Edit connection ${connection.name}`} onClick={() => { clearError(); setConnectionDialog({ ...connection, password: "", passphrase: "" }); }}><Pencil size={14} /></button><button title="Delete connection" aria-label={`Delete connection ${connection.name}`} onClick={() => void removeConnection(connection)}><Trash2 size={14} /></button></>}<button title="Gateway repository settings" aria-label="Gateway repository settings" onClick={() => { if (repository) { clearError(); setRepositoryDialog(repository); } }}><Settings size={15} /></button></div></div>
      {!bridgeReady ? <div className="empty"><Network size={38} /><strong>Gateway failed to initialize</strong><span>Close the application and run <code>npm run gateway</code> again.</span></div> : !connection ? <div className="empty"><Network size={38} /><strong>No SSH connections</strong><span>Add a connection to manage remote Vibe Editor workspaces.</span><button onClick={() => setConnectionDialog({ port: 22, authenticationMethod: "password", password: "", passphrase: "" })}><Plus size={15} /> Add connection</button></div> : <section className="workspace-view">
        <header><div><h1>Remote workspaces</h1><p>{connection.username}@{connection.host}</p></div><div className="workspace-header-actions"><button className="secondary" onClick={() => { clearError(); setDiscoverWorkspaceOnOpen(true); setWorkspaceDialog({ connectionId: connection.id, remotePort: 7331 }); }}><Search size={15} /> Discover workspaces</button><button onClick={() => { clearError(); setDiscoverWorkspaceOnOpen(false); setWorkspaceDialog({ connectionId: connection.id, remotePort: 7331 }); }}><Plus size={15} /> Add workspace</button></div></header>
        <div className="workspace-list">{workspaces.map((workspace) => { const current = runtimes[workspace.id] ?? { status: "idle", message: "Not running" }; const busy = current.status === "working"; const serverRunning = current.status === "server" || current.status === "client"; return <article key={workspace.id}>
          <div className="workspace-info"><div className={`status-dot ${current.status}`} aria-hidden="true" /><div><h2>{workspace.name}</h2><code>{workspace.directory}</code><span>Remote port {workspace.remotePort}</span></div><div className="status" role="status" aria-live="polite"><strong>{statusName(current.status)}</strong><small>{current.message}</small>{current.logs?.length ? <details><summary>Provisioning log</summary><pre>{current.logs.join("\n")}</pre></details> : null}</div></div>
          <div className="workspace-buttons"><button title={serverRunning ? "Server is already running" : "Start server"} disabled={busy || serverRunning} onClick={() => void action(workspace, "startServer")}><Play size={14} /> Start server</button>{busy && <button className="stop" onClick={() => void cancelProvisioning(workspace.id)}><CircleStop size={14} /> Cancel</button>}{current.status === "error" && current.retryable && <button onClick={() => void action(workspace, "startServer")}><RefreshCw size={14} /> Retry</button>}{current.status === "error" && current.repairable && <button onClick={() => void action(workspace, "repairServer")}><RefreshCw size={14} /> Repair</button>}<button disabled={busy} onClick={() => void action(workspace, "startClient")}><Laptop size={14} /> Start client</button><button className="stop" disabled={busy} onClick={() => void action(workspace, "stopServer")}><CircleStop size={14} /> Stop server</button><span className="workspace-action-spacer" /><button className="icon-button" title="Edit workspace" aria-label={`Edit workspace ${workspace.name}`} onClick={() => setWorkspaceDialog(workspace)}><Pencil size={14} /></button><button className="icon-button" title="Delete workspace" aria-label={`Delete workspace ${workspace.name}`} onClick={() => void removeWorkspace(workspace)}><Trash2 size={14} /></button></div>
        </article>; })}{workspaces.length === 0 && <div className="workspace-empty">No workspaces configured for this connection.</div>}</div>
        <section className="tunnel-section">
          <header><div><Cable size={16} /><div><h2>SSH port tunnels</h2><p>Forward a local port to the same port on {connection.host}.</p></div></div><form onSubmit={(event) => void addPortTunnel(event)}><input aria-label="Tunnel port" required type="number" min="1" max="65535" value={newTunnelPort} onChange={(event) => setNewTunnelPort(event.target.value)} placeholder="Port" /><button className="primary"><Plus size={14} /> Add port</button></form></header>
          <div className="tunnel-list">{connectionTunnels.map((item) => { const current = tunnelRuntimes[item.id] ?? { status: "idle", message: "Stopped" }; const busy = current.status === "working"; const running = current.status === "running"; return <div className="tunnel-row" key={item.id}><div className={`status-dot ${current.status}`} aria-hidden="true" /><div className="tunnel-address"><strong>localhost:{item.port}</strong><small>→ remote localhost:{item.port}</small></div><div className="tunnel-status" role="status" aria-live="polite"><strong>{tunnelStatusName(current.status)}</strong><small>{current.message}</small></div><button disabled={busy || running} onClick={() => void tunnelAction(item, "startPortTunnel")}><Play size={14} /> Run</button><button className="stop" disabled={busy || !running} onClick={() => void tunnelAction(item, "stopPortTunnel")}><CircleStop size={14} /> Stop</button><button title="Delete tunnel" aria-label={`Delete tunnel on port ${item.port}`} disabled={busy} onClick={() => void removePortTunnel(item)}><Trash2 size={14} /></button></div>; })}{connectionTunnels.length === 0 && <div className="tunnel-empty">No ports configured.</div>}</div>
        </section>
      </section>}
    </main>
    {bridgeReady && connectionDialog && <ConnectionDialog value={connectionDialog} onClose={() => setConnectionDialog(undefined)} onFailure={showError} onSave={async (value) => { const next = await window.gateway.saveConnection(value); setState(next); setSelected(value.id ?? next.connections.at(-1)?.id); setConnectionDialog(undefined); clearError(); }} />}
    {bridgeReady && workspaceDialog && connection && <WorkspaceDialog value={workspaceDialog} connectionId={connection.id} discoverOnOpen={discoverWorkspaceOnOpen} configuredDirectories={workspaces.map((item) => item.directory)} onClose={() => setWorkspaceDialog(undefined)} onFailure={showError} onSave={async (value) => { setState(await window.gateway.saveWorkspace(value)); setWorkspaceDialog(undefined); clearError(); }} />}
    {bridgeReady && repositoryDialog && <RepositoryDialog value={repositoryDialog} onClose={() => setRepositoryDialog(undefined)} onFailure={showError} onSave={async (value) => { const saved = await window.gateway.saveRepository(value); setRepository(saved); setRepositoryDialog(undefined); clearError(); }} />}
    {error && <GatewayErrorNotice message={error} onDismiss={clearError} />}
  </div>;
}

export function DiagnosticsCopyButton({ onCopy, onFailure }: { onCopy(): Promise<unknown>; onFailure(reason: unknown): void }) {
  const [status, setStatus] = useState<"idle" | "copying" | "success" | "error">("idle");
  const copy = async () => { setStatus("copying"); try { await onCopy(); setStatus("success"); } catch (reason) { setStatus("error"); onFailure(reason); } };
  return <><button title="Copy connection diagnostics" aria-label="Copy connection diagnostics" disabled={status === "copying"} onClick={() => void copy()}>{status === "success" ? <Check size={14} /> : <Copy size={14} />}</button><span className="visually-hidden" role="status" aria-live="polite">{status === "copying" ? "Copying connection diagnostics" : status === "success" ? "Connection diagnostics copied" : status === "error" ? "Connection diagnostics could not be copied" : ""}</span></>;
}

function useDialogKeyboard(onClose: () => void, accessibleName: string) {
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = document.querySelector<HTMLFormElement>(".dialog-layer:last-of-type .dialog");
    dialog?.setAttribute("role", "dialog"); dialog?.setAttribute("aria-modal", "true"); dialog?.setAttribute("aria-label", accessibleName);
    dialog?.querySelector<HTMLElement>("header button")?.setAttribute("aria-label", `Close ${accessibleName}`);
    (dialog?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])") ?? dialog?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener("keydown", onKeyDown);
    return () => { dialog?.removeEventListener("keydown", onKeyDown); previouslyFocused?.focus(); };
  }, [accessibleName, onClose]);
}

export function RepositoryDialog({ value, onClose, onSave, onFailure = () => undefined }: { value: GatewayRepositorySettings; onClose(): void; onSave(value: GatewayRepositorySettings): Promise<void>; onFailure?(reason: unknown): void }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false);
  useDialogKeyboard(onClose, "Gateway repository settings");
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await onSave({ repository: form.repository.trim(), branch: form.branch.trim(), autoUpdate: form.autoUpdate }); } catch (reason) { onFailure(reason); setSaving(false); } };
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>Gateway repository settings</strong><button type="button" onClick={onClose}><X size={15} /></button></header><p className="dialog-help">Gateway clones this source on SSH hosts when starting a server.</p><label>Git repository URL<input required value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })} placeholder="https://github.com/org/repository.git" /></label><label>Branch<input required value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} placeholder="main" /></label><label className="checkbox-field"><input type="checkbox" checked={form.autoUpdate} onChange={(event) => setForm({ ...form, autoUpdate: event.target.checked })} />Automatically fetch and deploy branch updates</label><footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving..." : "Save settings"}</button></footer></form></div>;
}

export function ConnectionDialog({ value, onClose, onSave, onFailure = () => undefined }: { value: Partial<GatewayConnection> & { password: string; passphrase: string }; onClose(): void; onSave(value: Partial<GatewayConnection> & { name: string; host: string; port: number; username: string; authenticationMethod: "password" | "privateKey" | "agent"; password?: string; passphrase?: string }): Promise<void>; onFailure?(reason: unknown): void }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [testResult, setTestResult] = useState("");
  useDialogKeyboard(onClose, form.id ? "Edit SSH connection" : "New SSH connection");
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await onSave({ ...form, name: form.name!.trim(), host: form.host!.trim(), port: Number(form.port), username: form.username!.trim(), authenticationMethod: form.authenticationMethod ?? "password", password: form.password, passphrase: form.passphrase }); } catch (reason) { onFailure(reason); setSaving(false); } };
  const chooseKey = async () => { try { const privateKeyPath = await window.gateway.pickPrivateKey(); if (privateKeyPath) setForm({ ...form, privateKeyPath }); } catch (reason) { onFailure(reason); } };
  const testConnection = async () => { setTesting(true); setTestResult(""); try { const result = await window.gateway.testConnection({ id: form.id, host: form.host?.trim() ?? "", port: Number(form.port), username: form.username?.trim() ?? "", authenticationMethod: form.authenticationMethod ?? "password", password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase }); setForm((current) => ({ ...current, hostKeyFingerprint: result.hostKeyFingerprint })); setTestResult(result.message); } catch (reason) { onFailure(reason); } finally { setTesting(false); } };
  const keyAuthentication = form.authenticationMethod === "privateKey";
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>{form.id ? "Edit SSH connection" : "New SSH connection"}</strong><button type="button" onClick={onClose} disabled={testing}><X size={15} /></button></header><label>Name<input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production server" /></label><div className="field-row"><label>Host<input required value={form.host ?? ""} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.50" /></label><label className="port">Port<input required type="number" min="1" max="65535" value={form.port ?? 22} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label></div><label>Username<input required value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Authentication<select value={form.authenticationMethod ?? "password"} onChange={(e) => setForm({ ...form, authenticationMethod: e.target.value as "password" | "privateKey" | "agent" })}><option value="password">Password</option><option value="privateKey">Private key</option><option value="agent">SSH agent</option></select></label>{keyAuthentication ? <><label>Private key file<div className="file-picker"><input required value={form.privateKeyPath ?? ""} onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })} placeholder="/Users/me/.ssh/id_ed25519" /><button type="button" onClick={() => void chooseKey()} disabled={testing}>Choose…</button></div></label><label>Key passphrase<input type="password" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} placeholder={form.id ? "Leave blank to keep saved passphrase" : "Optional"} /></label></> : form.authenticationMethod === "agent" ? <p className="dialog-help">Uses keys already loaded in your OS SSH agent. No private key or passphrase is saved by Gateway.</p> : <label>Password<input required={!form.id} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? "Leave blank to keep saved password" : "SSH password"} /></label>}{form.hostKeyFingerprint && <p className="dialog-help">Trusted server host key: <code>{form.hostKeyFingerprint}</code></p>}{testResult && <div className="form-success">{testResult}</div>}<footer><button type="button" onClick={onClose} disabled={testing}>Cancel</button><button type="button" onClick={() => void testConnection()} disabled={saving || testing}>{testing ? "Testing..." : "Test connection"}</button><button className="primary" disabled={saving || testing}>{saving ? "Saving..." : "Save connection"}</button></footer></form></div>;
}

export function WorkspaceDialog({ value, connectionId, discoverOnOpen = false, configuredDirectories = [], onClose, onSave, onFailure }: { value: Partial<GatewayWorkspace>; connectionId: string; discoverOnOpen?: boolean; configuredDirectories?: string[]; onClose(): void; onSave(value: Partial<GatewayWorkspace> & { connectionId: string; name: string; directory: string; remotePort: number }): Promise<void>; onFailure(reason: unknown): void }) {
  const [form, setForm] = useState(value); const [saving, setSaving] = useState(false); const [discovering, setDiscovering] = useState(false); const [directories, setDirectories] = useState<string[]>([]);
  useDialogKeyboard(onClose, form.id ? "Edit remote workspace" : "New remote workspace");
  const discover = useCallback(async () => { setDiscovering(true); try { setDirectories((await window.gateway.discoverWorkspaceDirectories(connectionId)).filter((directory) => !configuredDirectories.includes(directory) || directory === form.directory)); } catch (reason) { onFailure(reason); } finally { setDiscovering(false); } }, [configuredDirectories, connectionId, form.directory, onFailure]);
  useEffect(() => { if (discoverOnOpen) void discover(); }, [discoverOnOpen]); // Discovery is intentionally only triggered once when this dialog instance opens.
  const chooseDirectory = (directory: string) => { const name = directory.split("/").filter(Boolean).at(-1) ?? directory; setForm((current) => ({ ...current, directory, name: current.name || name })); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await onSave({ ...form, connectionId, name: form.name!.trim(), directory: form.directory!.trim(), remotePort: Number(form.remotePort) }); } catch (reason) { onFailure(reason); setSaving(false); } };
  return <div className="dialog-layer"><form className="dialog" onSubmit={(event) => void submit(event)}><header><strong>{form.id ? "Edit remote workspace" : "New remote workspace"}</strong><button type="button" onClick={onClose} disabled={saving || discovering}><X size={15} /></button></header>{directories.length > 0 && <label>Discovered workspaces<select aria-label="Discovered workspaces" value={directories.includes(form.directory ?? "") ? form.directory : ""} onChange={(event) => chooseDirectory(event.target.value)}><option value="">Select a remote folder…</option>{directories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}</select></label>}<label>Name<input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Backend API" /></label><label>Remote directory<input required value={form.directory ?? ""} onChange={(e) => setForm({ ...form, directory: e.target.value })} placeholder="/home/user/projects/api" /></label><button className="discover-workspaces" type="button" onClick={() => void discover()} disabled={saving || discovering}>{discovering ? "Discovering…" : directories.length ? "Discover again" : "Discover folders"}</button><p className="dialog-help">Lists folders in common project locations under the remote SSH user’s home. Already configured workspaces are omitted. You can still enter an absolute path manually; it will be checked before saving.</p><label>Core port<input required type="number" min="1024" max="65535" value={form.remotePort ?? 7331} onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} /></label><footer><button type="button" onClick={onClose} disabled={saving || discovering}>Cancel</button><button className="primary" disabled={saving || discovering}>{saving ? "Saving..." : "Save workspace"}</button></footer></form></div>;
}

function statusName(status: GatewayRuntime["status"]): string { return { idle: "Stopped", working: "In progress", server: "Server ready", client: "Client running", error: "Failed" }[status]; }
function tunnelStatusName(status: GatewayTunnelRuntime["status"]): string { return { idle: "Stopped", working: "Connecting", running: "Running", error: "Failed" }[status]; }
function connectionHealthName(status: GatewayConnectionRuntime["status"]): string { return { unknown: "SSH unchecked", reconnecting: "SSH reconnecting", online: "SSH online", slow: "SSH slow", offline: "SSH offline" }[status]; }
