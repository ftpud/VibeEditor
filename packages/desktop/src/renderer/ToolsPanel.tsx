import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpCircle, Check, CircleAlert, Download, LoaderCircle, Trash2, Wrench, X } from "lucide-react";
import type { ToolInstallation } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

const busy = (tool: ToolInstallation) => tool.status === "installing" || tool.status === "removing";
const installed = (tool: ToolInstallation) => tool.status === "installed" || !!tool.version;

/** Download, update and remove optional tools such as the Java runtime and language server on the Core host. */
export function ToolsPanel({ client, onClose }: { client: CoreClient; onClose(): void }) {
  const [tools, setTools] = useState<ToolInstallation[]>();
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [pending, setPending] = useState<string>();
  const close = useRef(onClose); close.current = onClose;
  const mounted = useRef(true);
  const load = async () => {
    try { const result = await client.request("tools.list", {}); if (mounted.current) { setTools(result.tools); setError(""); } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not load tools"); }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); } };
    document.addEventListener("keydown", key, true);
    return () => { mounted.current = false; document.removeEventListener("keydown", key, true); };
  }, [client]);
  const active = tools?.some(busy) ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [active, client]);
  const change = async (tool: string, operation: "tools.install" | "tools.uninstall") => {
    setPending(tool); setError(""); setConfirmRemove(undefined);
    try { const result = await client.request(operation, { tool }); if (mounted.current) setTools(result.tools); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The tool change failed"); }
    finally { if (mounted.current) setPending(undefined); }
  };
  const name = (id: string) => tools?.find((tool) => tool.id === id)?.name ?? id;

  return createPortal(<div className="dialog-overlay install-panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="install-panel" role="dialog" aria-modal="true" aria-labelledby="tools-title">
      <header className="install-panel-header">
        <div className="install-panel-heading"><Wrench size={22} /><div><h2 id="tools-title">Tools</h2><p>Optional tools downloaded to the Core host when you need them. Java highlighting, completion and navigation need both Java tools.</p></div></div>
        <div className="install-panel-header-actions"><button aria-label="Close tools" onClick={onClose}><X size={18} /></button></div>
      </header>
      <div className="install-panel-scroll">
        {error && <div className="install-panel-error" role="alert"><CircleAlert size={15} />{error}</div>}
        {!tools && !error && <div className="install-panel-loading" role="status"><LoaderCircle size={15} className="auth-spinner" />Loading tools…</div>}
        {tools?.map((tool) => {
          const update = !!tool.version && tool.version !== tool.availableVersion;
          const missing = (tool.requires ?? []).filter((id) => { const required = tools.find((item) => item.id === id); return required && !installed(required); });
          const disabled = busy(tool) || pending === tool.id;
          return <article className={`install-item-card ${installed(tool) ? "installed" : ""}`} key={tool.id} aria-label={tool.name}>
            <div className="install-item-main">
              <div className="install-item-title"><strong>{tool.name}</strong><ToolStatus tool={tool} update={update} /></div>
              <p>{tool.description}</p>
              <small className="install-item-meta">{tool.version && <span>Installed {tool.version}</span>}<span>{update ? `Available ${tool.availableVersion}` : tool.version ? "" : `Version ${tool.availableVersion}`}</span>{!!tool.requires?.length && <span>Requires {tool.requires.map(name).join(", ")}</span>}</small>
              {!!missing.length && installed(tool) && <div className="install-panel-error" role="alert"><CircleAlert size={14} />Install {missing.map(name).join(", ")} to use this tool.</div>}
              {tool.error && <div className="install-panel-error" role="alert"><CircleAlert size={14} />{tool.error}</div>}
            </div>
            <div className="install-item-actions">
              {tool.status === "not_installed" && <button className="primary" disabled={disabled} title={missing.length ? `Also installs ${missing.map(name).join(", ")}` : undefined} onClick={() => void change(tool.id, "tools.install")}><Download size={14} />Install</button>}
              {installed(tool) && update && <button disabled={disabled} onClick={() => void change(tool.id, "tools.install")}><ArrowUpCircle size={14} />Update</button>}
              {installed(tool) && <button className="danger" disabled={disabled} onClick={() => setConfirmRemove(tool.id)}><Trash2 size={14} />Delete</button>}
            </div>
            {confirmRemove === tool.id && <div className="install-item-confirm" role="alertdialog" aria-label={`Confirm deleting ${tool.name}`}><span>Delete {tool.name} from the Core host? Features that use it stop working until it is installed again.</span><div><button onClick={() => setConfirmRemove(undefined)}>Cancel</button><button className="danger" onClick={() => void change(tool.id, "tools.uninstall")}><Trash2 size={14} />Delete</button></div></div>}
          </article>;
        })}
      </div>
      <footer className="install-panel-footer"><span>Tools are stored in <code>~/.remote-ide/tools</code> on the Core host and shared by all projects.</span><span>{active ? "Downloads continue if you close this panel" : ""}</span></footer>
    </section>
  </div>, document.body);
}

function ToolStatus({ tool, update }: { tool: ToolInstallation; update: boolean }) {
  if (tool.status === "installing") return <span className="install-item-badge working"><LoaderCircle size={12} className="auth-spinner" />{tool.version ? "Updating" : "Downloading"}{tool.progress !== undefined ? ` ${tool.progress}%` : "…"}</span>;
  if (tool.status === "removing") return <span className="install-item-badge working"><LoaderCircle size={12} className="auth-spinner" />Deleting…</span>;
  if (tool.status === "not_installed") return <span className="install-item-badge">Not installed</span>;
  if (update) return <span className="install-item-badge update"><ArrowUpCircle size={12} />Update available</span>;
  return <span className="install-item-badge ok"><Check size={12} />Installed</span>;
}
