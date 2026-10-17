import { useEffect, useRef, useState } from "react";
import type { FileRevision, LanguageDebugState, LanguageDescriptor, LanguageExtra, LanguageProjectNode, LanguageRunTarget } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { languageClient } from "./language-client";
import { DebugVariable } from "./DebugVariable";
import "./language-tools.css";

type Props = {
  client: CoreClient;
  languages: LanguageDescriptor[];
  selected?: string;
  open: boolean;
  onSelect(id: string): void;
  onClose(): void;
  onOpenFile(path: string): void;
  beforeLaunch(): Promise<unknown>;
};
type ProcessState = { running: boolean; log: string; debug?: LanguageDebugState };
const idle: ProcessState = { running: false, log: "" };

/** UI shared by built-in and plugin languages. Core owns all project files and processes. */
export function LanguageTools({ client, languages, selected, open, onSelect, onClose, onOpenFile, beforeLaunch }: Props) {
  const descriptor = languages.find((language) => language.id === selected) ?? languages[0];
  const language = descriptor?.id;
  const [processes, setProcesses] = useState<Record<string, ProcessState>>({});
  const process = language ? processes[language] ?? idle : idle;
  useEffect(() => client.subscribeServerEvents((event) => {
    if (!(event.type === "language.output" || event.type === "language.exit" || event.type === "language.debug.state") || event.payload.rootId !== client.getRoot()) return;
    const payload = event.payload;
    setProcesses((current) => {
      const previous = current[payload.language] ?? idle;
      if (event.type === "language.output") return { ...current, [payload.language]: { ...previous, log: (previous.log + event.payload.data).slice(-1_000_000) } };
      if (event.type === "language.exit") return { ...current, [payload.language]: { ...previous, running: false, log: `${previous.log}\nProcess exited${event.payload.exitCode === null ? "" : ` with code ${event.payload.exitCode}`}\n` } };
      return { ...current, [payload.language]: { ...previous, debug: event.payload, running: event.payload.status !== "stopped" } };
    });
  }), [client]);
  if (!language || !descriptor) return open ? <div className="dialog-overlay"><section className="language-tools" role="dialog" aria-label="Language tools"><button onClick={onClose}>Close</button><p>No language services are available.</p></section></div> : null;
  return <LanguageWorkspace key={language} {...{ client, languages, descriptor, open, onSelect, onClose, onOpenFile, beforeLaunch, process }} onRunning={(running) => setProcesses((current) => ({ ...current, [language]: { ...(current[language] ?? idle), running } }))} />;
}

function LanguageWorkspace({ client, languages, descriptor, open, onSelect, onClose, onOpenFile, beforeLaunch, process, onRunning }: Omit<Props, "selected"> & { descriptor: LanguageDescriptor; process: ProcessState; onRunning(running: boolean): void }) {
  const service = languageClient(client, descriptor.id);
  const capabilities = descriptor.capabilities;
  const [tree, setTree] = useState<LanguageProjectNode[]>([]);
  const [targets, setTargets] = useState<LanguageRunTarget[]>([]);
  const [options, setOptions] = useState<LanguageExtra>({});
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [sourceRoot, setSourceRoot] = useState("");
  const [configuration, setConfiguration] = useState<{ path: string; content: string; revision?: FileRevision }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const refresh = async () => {
    const jobs: Promise<void>[] = [];
    if (capabilities.projectTree) jobs.push(service.request("language.projectTree", {}).then(({ tree }) => { if (current.current) setTree(tree); }));
    if (capabilities.run) jobs.push(service.request("language.listRunTargets", {}).then(({ targets }) => { if (current.current) setTargets(targets); }));
    if (capabilities.runConfigurations) jobs.push(service.request("language.options", {}).then(({ options }) => { if (current.current) setOptions(options); }));
    if (capabilities.configuration) jobs.push(service.request("language.configuration.read", {}).then((value) => { if (current.current) setConfiguration({ ...value, content: value.content || value.template || "" }); }));
    const results = await Promise.allSettled(jobs);
    const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : []);
    if (current.current) setError(failures.join("\n"));
  };
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void refresh().finally(() => { if (current.current) setLoading(false); });
  }, [open]);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy || loading) return;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { if (current.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current.current) setBusy(false); }
  };
  const launch = (action: "language.build" | "language.run" | "language.debug.start") => perform(async () => {
    await beforeLaunch();
    if (!current.current) return;
    onRunning(true);
    try {
      if (action === "language.debug.start") await service.startDebug([], { timeoutMs: 10 * 60_000 });
      else await service.request(action, {}, { timeoutMs: 10 * 60_000 });
    } catch (cause) { onRunning(false); throw cause; }
    finally { if (action === "language.build") onRunning(false); }
  });
  const configurations = Array.isArray(options.runConfigurations) ? options.runConfigurations.filter((value): value is { id: string; name: string } => !!value && typeof value === "object" && typeof value.id === "string" && typeof value.name === "string") : [];
  if (!open) return null;
  return <div className="dialog-overlay" onMouseDown={onClose}>
    <section className="language-tools" role="dialog" aria-modal="true" aria-label="Language tools" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }} onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>Language tools</h2><button onClick={onClose}>Close</button></header>
      <label>Language <select value={descriptor.id} onChange={(event) => onSelect(event.target.value)}>{languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}</select></label>
      <div className="language-tools-actions" role="toolbar" aria-label={`${descriptor.name} controls`}>
        <button disabled={busy || loading} onClick={() => void perform(refresh)}>Refresh</button>
        {capabilities.build && <button disabled={busy || loading || process.running} onClick={() => void launch("language.build")}>Build</button>}
        {capabilities.run && <button disabled={busy || loading || process.running} onClick={() => void launch("language.run")}>Run</button>}
        {capabilities.debug && <button disabled={busy || loading || process.running} onClick={() => void launch("language.debug.start")}>Debug</button>}
        {(capabilities.run || capabilities.build || capabilities.debug) && <button disabled={!process.running} onClick={() => void service.request("language.stop", {}).catch((cause: Error) => setError(cause.message))}>Stop</button>}
      </div>
      {error && <p role="alert" className="language-tools-error">{error}</p>}
      <div className="language-tools-columns">
        {capabilities.projectTree && <section><h3>Project tree</h3><LanguageTree nodes={tree} onOpenFile={onOpenFile} />{capabilities.sourceRoots && <><label>Source root <input value={sourceRoot} onChange={(event) => setSourceRoot(event.target.value)} /></label><button disabled={busy || loading || !sourceRoot.trim()} onClick={() => void perform(async () => { await service.request("language.addSourceRoot", { path: sourceRoot.trim() }); await refresh(); })}>Add source root</button></>}</section>}
        <section>
          {capabilities.run && <><h3>Run targets</h3>{targets.length ? <ul>{targets.map((item) => <li key={item.id}>{item.name}</li>)}</ul> : <p>No run targets found.</p>}</>}
          {capabilities.runConfigurations && <><h3>Run configurations</h3><label>Selected configuration <select disabled={busy || loading || process.running} value={typeof options.selectedRunConfigurationId === "string" ? options.selectedRunConfigurationId : ""} onChange={(event) => void perform(async () => { const result = await service.request("language.selectRunConfiguration", { id: event.target.value }); if (current.current) setOptions(result.options); })}><option value="" disabled>Select configuration</option>{configurations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Target <select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Select target</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <button disabled={busy || loading || process.running || !target || !name.trim()} onClick={() => void perform(async () => { const result = await service.request("language.addRunConfiguration", { name: name.trim(), target }); if (current.current) setOptions(result.options); })}>Add configuration</button></>}
          {capabilities.configuration && configuration && <><h3>Configuration</h3><label>{configuration.path}<textarea aria-label={`${descriptor.name} configuration`} spellCheck={false} value={configuration.content} onChange={(event) => setConfiguration({ ...configuration, content: event.target.value })} /></label><button disabled={busy || loading || process.running} onClick={() => void perform(async () => { const saved = await service.request("language.configuration.save", { content: configuration.content, expectedRevision: configuration.revision }); if (current.current) { setConfiguration({ ...configuration, ...saved }); if (saved.options) setOptions(saved.options); } })}>Save configuration</button></>}
        </section>
      </div>
      {(capabilities.build || capabilities.run || capabilities.debug) && <><h3>Output</h3><pre className="language-tools-output">{process.log || "Process output will appear here."}</pre></>}
      {capabilities.debug && process.debug && process.debug.status !== "stopped" && <section><h3>Debugger: {process.debug.status}</h3><p>{process.debug.frame} {process.debug.path}:{process.debug.line}</p><div className="language-tools-actions">{(["continue", "stepOver", "stepInto", "stepOut"] as const).map((command) => <button key={command} disabled={busy || process.debug?.status !== "paused" || process.debug.busy} onClick={() => void perform(() => service.debugCommand(command))}>{command}</button>)}</div>{process.debug.variables.map((variable) => <DebugVariable key={variable.reference ?? variable.name} variable={variable} onInspect={service.debugVariables} disabled={busy || process.debug?.busy} />)}</section>}
    </section>
  </div>;
}

export function LanguageTree({ nodes, onOpenFile }: { nodes: LanguageProjectNode[]; onOpenFile(path: string): void }) {
  return <ul className="language-project-tree">{nodes.map((node) => <li key={`${node.type}:${node.path}`}>{node.type === "file" ? <button onClick={() => onOpenFile(node.path)}>{node.name}</button> : <details open><summary>{node.name}</summary><LanguageTree nodes={node.children ?? []} onOpenFile={onOpenFile} /></details>}</li>)}</ul>;
}
