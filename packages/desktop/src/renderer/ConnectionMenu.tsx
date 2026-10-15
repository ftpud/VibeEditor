import { ChevronDown, LogOut, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ConnectionMenu({ host, port, connected, onDisconnect }: { host: string; port: string; connected: boolean; onDisconnect(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="connection-menu" ref={root}>
    <button ref={trigger} className="connection-menu-trigger" aria-label="Core connection" aria-expanded={open} onClick={() => setOpen(!open)} title={`${connected ? "Connected to" : "Disconnected from"} ${host}:${port}`}><span className={`connection-indicator ${connected ? "connected" : ""}`} /><span>{connected ? local ? "Local Core" : "Remote Core" : "Offline"}</span><ChevronDown size={12} /></button>
    {open && <section className="connection-popover" role="dialog" aria-label="Connection details"><header><Server size={18} /><div><strong>{local ? "Local workspace" : "Remote workspace"}</strong><small role="status">{connected ? "Connected" : "Disconnected"}</small></div></header><dl><dt>Core address</dt><dd>{host}:{port}</dd></dl><button className="connection-disconnect" onClick={onDisconnect}><LogOut size={15} />Disconnect</button></section>}
  </div>;
}
