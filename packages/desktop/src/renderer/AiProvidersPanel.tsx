import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpCircle, Bot, Check, CircleAlert, Download, LoaderCircle, RefreshCw, Server, Trash2, X } from "lucide-react";
import type { AiProviderInstallation } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { AiAuthentication } from "./AiAuthentication";

const busy = (item: AiProviderInstallation) => item.status === "installing" || item.status === "removing";
const usable = (item: AiProviderInstallation) => item.status === "installed" || !!item.version;

/** Install, update and remove provider agents on the Core host, and check each provider's account. */
export function AiProvidersPanel({ client, onClose, onChanged }: { client: CoreClient; onClose(): void; onChanged(): void }) {
  const [installations, setInstallations] = useState<AiProviderInstallation[]>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [pending, setPending] = useState<string>();
  const close = useRef(onClose); close.current = onClose;
  const changed = useRef(onChanged); changed.current = onChanged;
  const previous = useRef<Map<string, AiProviderInstallation>>(new Map());
  const mounted = useRef(true);

  const apply = (items: AiProviderInstallation[]) => {
    // Refresh the app's provider list whenever an install, update or removal finishes.
    const finished = items.some((item) => { const before = previous.current.get(item.provider); return before && busy(before) && !busy(item); });
    previous.current = new Map(items.map((item) => [item.provider, item]));
    setInstallations(items);
    if (finished) changed.current();
  };
  const load = async (checkLatest = false) => {
    try { const result = await client.request("ai.installations.list", { checkLatest }, checkLatest ? { timeoutMs: 60_000 } : undefined); if (mounted.current) { apply(result.installations); setError(""); } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not load AI providers"); }
  };
  const checkUpdates = async () => { setChecking(true); try { await load(true); } finally { if (mounted.current) setChecking(false); } };

  useEffect(() => {
    mounted.current = true;
    void load().then(() => checkUpdates());
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); } };
    document.addEventListener("keydown", key, true);
    return () => { mounted.current = false; document.removeEventListener("keydown", key, true); };
  }, [client]);
  const active = installations?.some(busy) ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [active, client]);

  const change = async (provider: string, operation: "ai.installations.install" | "ai.installations.uninstall") => {
    setPending(provider); setError(""); setConfirmRemove(undefined);
    try {
      const { installation } = await client.request(operation, { provider });
      if (mounted.current) apply((installations ?? []).map((item) => item.provider === provider ? installation : item));
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "The installation change failed"); }
    finally { if (mounted.current) setPending(undefined); }
  };

  return createPortal(<div className="dialog-overlay install-panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="install-panel" role="dialog" aria-modal="true" aria-labelledby="install-panel-title">
      <header className="install-panel-header">
        <div className="install-panel-heading"><Bot size={22} /><div><h2 id="install-panel-title">AI providers</h2><p>Agents installed on the Core host. Only installed providers can be used in chats and workflows.</p></div></div>
        <div className="install-panel-header-actions"><button disabled={checking || !installations} onClick={() => void checkUpdates()}>{checking ? <LoaderCircle size={14} className="auth-spinner" /> : <RefreshCw size={14} />}Check for updates</button><button aria-label="Close AI providers" onClick={onClose}><X size={18} /></button></div>
      </header>
      <div className="install-panel-scroll">
        {error && <div className="install-panel-error" role="alert"><CircleAlert size={15} />{error}</div>}
        {!installations && !error && <div className="install-panel-loading" role="status"><LoaderCircle size={15} className="auth-spinner" />Loading providers…</div>}
        {installations?.map((item) => {
          const external = item.source === "external";
          const update = !external && !!item.version && !!item.latestVersion && item.latestVersion !== item.version;
          const disabled = busy(item) || pending === item.provider;
          return <article className={`install-item-card ${usable(item) ? "installed" : ""}`} key={item.provider} aria-label={item.name}>
            <div className="install-item-main">
              <div className="install-item-title"><strong>{item.name}</strong><ProviderStatus item={item} update={update} /></div>
              <p>{item.description}</p>
              <small className="install-item-meta">{external ? <><Server size={12} />Configured on the Core host: <code>{item.location}</code></> : <>{item.package && <code>{item.package}</code>}{item.version && <span>Installed {item.version}</span>}{item.latestVersion && <span>Latest {item.latestVersion}</span>}</>}</small>
              {item.error && <div className="install-panel-error" role="alert"><CircleAlert size={14} />{item.error}</div>}
            </div>
            {!external && <div className="install-item-actions">
              {item.status === "not_installed" && <button className="primary" disabled={disabled} onClick={() => void change(item.provider, "ai.installations.install")}><Download size={14} />Install</button>}
              {usable(item) && <button disabled={disabled} title={update ? `Update to ${item.latestVersion}` : "Install the latest published version"} onClick={() => void change(item.provider, "ai.installations.install")}><ArrowUpCircle size={14} />Update</button>}
              {usable(item) && <button className="danger" disabled={disabled} onClick={() => setConfirmRemove(item.provider)}><Trash2 size={14} />Delete</button>}
            </div>}
            {confirmRemove === item.provider && <div className="install-item-confirm" role="alertdialog" aria-label={`Confirm deleting ${item.name}`}><span>Delete {item.name} from the Core host? Chats and workflows using it stop working until it is installed again. Provider sign-in and history are kept.</span><div><button onClick={() => setConfirmRemove(undefined)}>Cancel</button><button className="danger" onClick={() => void change(item.provider, "ai.installations.uninstall")}><Trash2 size={14} />Delete</button></div></div>}
            {usable(item) && !busy(item) && <div className="install-item-account"><span>Account</span><AiAuthentication provider={item.provider} checkOnMount /></div>}
          </article>;
        })}
      </div>
      <footer className="install-panel-footer"><span>Installations download from npm into <code>~/.remote-ide/provider-runtimes</code> on the Core host.</span><span>{active ? "Changes continue if you close this panel" : ""}</span></footer>
    </section>
  </div>, document.body);
}

function ProviderStatus({ item, update }: { item: AiProviderInstallation; update: boolean }) {
  if (item.status === "installing") return <span className="install-item-badge working"><LoaderCircle size={12} className="auth-spinner" />{item.version ? "Updating…" : "Installing…"}</span>;
  if (item.status === "removing") return <span className="install-item-badge working"><LoaderCircle size={12} className="auth-spinner" />Deleting…</span>;
  if (item.status === "not_installed") return <span className="install-item-badge">Not installed</span>;
  if (update) return <span className="install-item-badge update"><ArrowUpCircle size={12} />Update available</span>;
  return <span className="install-item-badge ok"><Check size={12} />{item.source === "external" ? "Host-configured" : "Installed"}</span>;
}
