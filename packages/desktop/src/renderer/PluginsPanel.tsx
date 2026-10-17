import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, LoaderCircle, Puzzle, X } from "lucide-react";
import type { PluginStatus } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

/** Read-only list of plugins found on the Core host. Plugins are enabled and disabled on the host, not from Desktop. */
export function PluginsPanel({ client, onClose }: { client: CoreClient; onClose: () => void }) {
  const [state, setState] = useState<{ enabled: boolean; plugins: PluginStatus[] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    client.request("plugins.list", {}).then((result) => { if (current) setState(result); }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Could not list plugins"); });
    return () => { current = false; };
  }, [client]);
  return createPortal(<div className="dialog-overlay install-panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="install-panel" role="dialog" aria-modal="true" aria-labelledby="plugins-title">
      <header className="install-panel-header">
        <div className="install-panel-heading"><Puzzle size={22} /><div><h2 id="plugins-title">Plugins</h2><p>Plugins run code on the Core host. Set REMOTE_IDE_PLUGINS_DIR on the host to enable them; restart Core after changing the directory.</p></div></div>
        <div className="install-panel-header-actions"><button aria-label="Close plugins" onClick={onClose}><X size={18} /></button></div>
      </header>
      <div className="install-panel-scroll">
        {error && <div className="install-panel-error" role="alert"><CircleAlert size={15} />{error}</div>}
        {!state && !error && <div className="install-panel-loading" role="status"><LoaderCircle size={15} className="auth-spinner" />Loading plugins…</div>}
        {state && !state.enabled && <p>Plugins are not enabled on this Core host.</p>}
        {state?.enabled && state.plugins.length === 0 && <p>No plugins were found in the plugin directory.</p>}
        {state?.plugins.map((plugin) => <article className={`install-item-card ${plugin.state === "loaded" ? "installed" : ""}`} key={plugin.id} aria-label={plugin.name ?? plugin.id}>
          <div className="install-item-main">
            <div className="install-item-title"><strong>{plugin.name ?? plugin.id}</strong><span>{plugin.state === "loaded" ? "Loaded" : "Not loaded"}</span></div>
            <small className="install-item-meta">{plugin.version && <span>Version {plugin.version}</span>}{plugin.providers.length > 0 && <span>Providers: {plugin.providers.join(", ")}</span>}{plugin.languages.length > 0 && <span>Languages: {plugin.languages.join(", ")}</span>}</small>
            {plugin.error && <p className="install-panel-error" role="alert">{plugin.error}</p>}
          </div>
        </article>)}
      </div>
    </section>
  </div>, document.body);
}
