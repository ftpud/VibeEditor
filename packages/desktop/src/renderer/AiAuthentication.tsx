import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, ExternalLink, LoaderCircle, LogIn, RefreshCw, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AiAuthentication as Authentication, AiAuthInput } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import "@xterm/xterm/css/xterm.css";

export const AuthenticationClientContext = createContext<CoreClient | null>(null);
const initial: Authentication = { status: "unknown", methods: [] };

/** Provider account status and sign-in. `checkOnMount` verifies the account by opening an agent session on the Core host. */
export function AiAuthentication({ provider, disabled = false, checkOnMount = false }: { provider: string; disabled?: boolean; checkOnMount?: boolean }) {
  const client = useContext(AuthenticationClientContext);
  const root = client?.getRoot();
  const [state, setState] = useState<Authentication>(initial);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const status = useRef(state.status); status.current = state.status;
  useEffect(() => {
    const revision = ++generation.current;
    setState(initial); setOpen(false); setError(""); setLoading(false);
    if (!client) return;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await client.request("ai.auth.get", { provider });
        if (generation.current !== revision) return;
        if (result.authentication.status === "required" && status.current !== "required") setOpen(true);
        setState(result.authentication);
      } catch { /* Reconnection is handled by the workspace; preserve the live sign-in view. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1500);
    return () => { generation.current++; clearInterval(timer); };
  }, [client, provider, root]);
  if (!client) return null;
  const active = state.status === "authenticating";
  const input = async (payload: Omit<AiAuthInput, "requestId">) => {
    if (!state.requestId) return;
    const revision = generation.current;
    try {
      const result = await client.request("ai.auth.input", { provider, requestId: state.requestId, ...payload });
      if (generation.current === revision) setState(result.authentication);
    } catch (reason) { if (generation.current === revision) setError(reason instanceof Error ? reason.message : "Sign-in failed"); }
  };
  const discover = async (expand = true) => {
    if (expand) setOpen(true);
    setError("");
    if (active) return;
    const revision = generation.current;
    setLoading(true);
    try {
      const result = await client.request("ai.auth.get", { provider, discover: true }, { timeoutMs: 210000 });
      if (generation.current !== revision) return;
      setState(result.authentication);
      if (result.authentication.status === "required" || result.authentication.status === "error") setOpen(true);
    } catch (reason) { if (generation.current === revision) { setError(reason instanceof Error ? reason.message : "Could not check the account"); setOpen(true); } }
    finally { if (generation.current === revision) setLoading(false); }
  };
  const discoverRef = useRef(discover); discoverRef.current = discover;
  useEffect(() => { if (checkOnMount && client) void discoverRef.current(false); }, [checkOnMount, client, provider, root]);
  const start = async (methodId: string) => {
    const revision = generation.current;
    setLoading(true); setError("");
    try {
      const result = await client.request("ai.auth.start", { provider, methodId });
      if (generation.current === revision) setState(result.authentication);
    } catch (reason) { if (generation.current === revision) setError(reason instanceof Error ? reason.message : "Could not start sign-in"); }
    finally { if (generation.current === revision) setLoading(false); }
  };
  const links = [...new Set([state.url, ...(state.output?.match(/https?:\/\/[^\s<>\x1b\x07]+/g) ?? [])].filter((url): url is string => !!url))].slice(0, 4);
  return <section className={`ai-authentication ${open ? "expanded" : ""}`} aria-label="Provider authentication">
    <div className="ai-authentication-summary"><span>{loading && !open ? <><LoaderCircle size={13} className="auth-spinner" />Checking account…</> : state.status === "authenticated" ? <><Check size={13} />Signed in</> : active ? <><LoaderCircle size={13} className="auth-spinner" />Signing in…</> : state.status === "required" ? "Sign in to continue" : state.status === "error" ? <><CircleAlert size={13} />Could not verify account</> : "Account not checked"}</span><span className="ai-authentication-buttons"><button type="button" disabled={disabled || loading || active} title="Check whether this provider is signed in on the Core host" onClick={() => void discover(false)}><RefreshCw size={13} />Check</button><button type="button" disabled={disabled || loading} aria-expanded={open} onClick={() => open ? setOpen(false) : void discover()}><LogIn size={13} />{open ? "Hide" : state.status === "authenticated" ? "Account" : "Sign in"}</button></span></div>
    {open && <div className="ai-authentication-body">
      <p>Sign in on the Core host. Your credentials stay with the provider.</p>
      {loading && <span role="status"><LoaderCircle size={14} className="auth-spinner" />Checking account and sign-in options…</span>}
      {!active && !loading && state.methods.map(method => <button type="button" className="ai-authentication-method" key={method.id} disabled={disabled} onClick={() => void start(method.id)}><span><strong>{method.name}</strong>{method.description && <small>{method.description}</small>}</span><LogIn size={15} /></button>)}
      {!active && !loading && !state.methods.length && <p>This agent has not advertised sign-in methods. Check its installation or Core-host authentication.</p>}
      {state.message && <p className="ai-authentication-message">{state.message}</p>}
      {links.map(url => <button type="button" className="ai-authentication-link" key={url} onClick={() => { void window.desktop?.openExternal(url).catch(reason => setError(String(reason))); }}><ExternalLink size={13} /><span>{url}</span></button>)}
      {active && state.terminal && <AuthenticationTerminal key={state.requestId} output={state.output ?? ""} onInput={data => { void input({ data }); }} onResize={(cols, rows) => { void input({ cols, rows }); }} />}
      {!state.terminal && state.output && <pre className="ai-authentication-output">{state.output}</pre>}
      {(error || state.error) && <div className="ai-authentication-error" role="alert">{error || state.error}</div>}
      {active && <div className="ai-authentication-actions">{state.awaitingConfirmation && <button type="button" onClick={() => { void input({ action: "accept" }); }}>Continue after signing in</button>}<button type="button" onClick={() => { void input({ action: "cancel" }); }}><X size={13} />Cancel sign-in</button></div>}
    </div>}
  </section>;
}

function AuthenticationTerminal({ output, onInput, onResize }: { output: string; onInput(data: string): void; onResize(cols: number, rows: number): void }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const previous = useRef("");
  const handlers = useRef({ onInput, onResize }); handlers.current = { onInput, onResize };
  useEffect(() => {
    if (!element.current) return;
    const style = getComputedStyle(element.current);
    const view = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 12, fontFamily: "Menlo, Monaco, Consolas, monospace", theme: { background: style.getPropertyValue("--surface-base").trim() || "#171c28", foreground: style.getPropertyValue("--text-primary").trim() || "#dce2ef" } });
    const fit = new FitAddon(); view.loadAddon(fit); view.open(element.current); terminal.current = view;
    const data = view.onData(value => handlers.current.onInput(value));
    const resize = () => { try { fit.fit(); handlers.current.onResize(view.cols, view.rows); } catch { /* Wait for the chat panel to be laid out. */ } };
    const observer = new ResizeObserver(resize); observer.observe(element.current); resize(); view.focus();
    return () => { observer.disconnect(); data.dispose(); view.dispose(); terminal.current = undefined; previous.current = ""; };
  }, []);
  useEffect(() => {
    const view = terminal.current;
    if (!view) return;
    if (output.startsWith(previous.current)) view.write(output.slice(previous.current.length));
    else { view.reset(); view.write(output); }
    previous.current = output;
  }, [output]);
  return <div className="ai-authentication-terminal" role="group" aria-label="Interactive provider sign-in terminal" ref={element} />;
}
