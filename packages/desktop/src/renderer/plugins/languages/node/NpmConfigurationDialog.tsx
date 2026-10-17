import { useEffect, useId, useRef, useState } from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import type { FileRevision, LanguageExtra, LanguageRunTarget, LanguageToolCheck } from "@remote-ide/protocol";
import type { CoreClient } from "../../../client";
import { languageClient } from "../../../language-client";
import "./npm-configuration.css";

type NpmRunConfiguration = { id: string; name: string; script: string; arguments?: string[]; nodeOptions?: string[]; environment?: Record<string, string>; environmentFile?: string; workingDirectory?: string };
type NpmProjectOptions = { type: "npm"; packageJsonPath: string; packageManager: "npm" | "pnpm" | "yarn"; executable?: string; runConfigurations: NpmRunConfiguration[]; selectedRunConfigurationId?: string };
type Props = { client: CoreClient; running: boolean; onClose(): void; onSaved(options: LanguageExtra): void };
const tabs = ["Launch", "Environment", "Tools"] as const;
const environmentText = (value: Record<string, string> = {}) => Object.entries(value).map(([key, value]) => `${key}=${value}`).join("\n");
function environmentValues(text: string, profile: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = line.slice(0, equals).trim();
    if (equals < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${profile}: use KEY=value, one environment variable per line.`);
    if (Object.hasOwn(result, key)) throw new Error(`${profile}: ${key} is listed more than once.`);
    result[key] = line.slice(equals + 1);
  }
  return result;
}
function parseOptions(content: string): NpmProjectOptions {
  const options = JSON.parse(content) as NpmProjectOptions;
  if (!options || options.type !== "npm" || typeof options.packageJsonPath !== "string" || !["npm", "pnpm", "yarn"].includes(options.packageManager) || !Array.isArray(options.runConfigurations)) throw new Error("The npm project settings are invalid. Register package.json again to initialize them.");
  return options;
}

export function NpmConfigurationDialog({ client, running, onClose, onSaved }: Props) {
  const service = languageClient(client, "node");
  const id = useId();
  const mounted = useRef(true);
  const [options, setOptions] = useState<NpmProjectOptions>();
  const [revision, setRevision] = useState<FileRevision>();
  const [targets, setTargets] = useState<LanguageRunTarget[]>([]);
  const [profileId, setProfileId] = useState("");
  const [tab, setTab] = useState<typeof tabs[number]>("Launch");
  const [drafts, setDrafts] = useState<Record<string, { arguments?: string; nodeOptions?: string; environment?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<LanguageToolCheck[]>();
  const [error, setError] = useState("");
  const profile = options?.runConfigurations.find((item) => item.id === profileId) ?? options?.runConfigurations[0];
  const busy = saving || checking;
  useEffect(() => {
    mounted.current = true;
    let current = true;
    void Promise.all([service.request("language.configuration.read", {}), service.request("language.listRunTargets", {})]).then(([configuration, { targets }]) => {
      if (!current) return;
      const options = parseOptions(configuration.content);
      setOptions(options); setRevision(configuration.revision); setTargets(targets);
      setProfileId(options.selectedRunConfigurationId ?? options.runConfigurations[0]?.id ?? "");
    }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; mounted.current = false; };
  }, [client]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [busy, onClose]);
  const updateProfile = (value: Partial<NpmRunConfiguration>) => {
    if (options && profile) setOptions({ ...options, runConfigurations: options.runConfigurations.map((item) => item.id === profile.id ? { ...item, ...value } : item) });
    setChecks(undefined); setError("");
  };
  const draft = (key: "arguments" | "nodeOptions" | "environment", value: string) => { if (profile) setDrafts((current) => ({ ...current, [profile.id]: { ...current[profile.id], [key]: value } })); setChecks(undefined); };
  const content = () => {
    if (!options) throw new Error("Project settings have not loaded.");
    return JSON.stringify({ ...options, runConfigurations: options.runConfigurations.map((item) => {
      if (!item.name.trim()) throw new Error("Give every configuration a name.");
      if (!targets.some((target) => target.id === item.script)) throw new Error(`${item.name}: choose a script from package.json.`);
      return { ...item, name: item.name.trim(), ...(drafts[item.id]?.arguments !== undefined ? { arguments: drafts[item.id]!.arguments!.split(/\r?\n/).filter((line) => line.length > 0) } : {}), ...(drafts[item.id]?.nodeOptions !== undefined ? { nodeOptions: drafts[item.id]!.nodeOptions!.split(/\r?\n/).filter((line) => line.length > 0) } : {}), ...(drafts[item.id]?.environment !== undefined ? { environment: environmentValues(drafts[item.id]!.environment!, item.name) } : {}) };
    }) }, null, 2) + "\n";
  };
  const add = (duplicate: boolean) => {
    if (!options) return;
    try {
      const latest = parseOptions(content());
      const source = latest.runConfigurations.find((item) => item.id === profile?.id);
      const configuration: NpmRunConfiguration = duplicate && source ? { ...source, id: crypto.randomUUID(), name: `${source.name} copy`, environment: { ...source.environment } } : { id: crypto.randomUUID(), name: "New configuration", script: targets.find((item) => item.id === "dev")?.id ?? targets.find((item) => item.id === "start")?.id ?? targets[0]?.id ?? "", arguments: [], environment: {} };
      setOptions({ ...latest, runConfigurations: [...latest.runConfigurations, configuration], selectedRunConfigurationId: latest.selectedRunConfigurationId ?? configuration.id });
      setProfileId(configuration.id); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const save = async () => {
    if (busy || loading || running) return;
    setSaving(true); setError("");
    try { const saved = await service.request("language.configuration.save", { content: content(), expectedRevision: revision }); if (mounted.current) onSaved(saved.options ?? {}); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const check = async () => {
    setChecking(true); setError("");
    try { const result = await service.request("language.tools.check", { content: content() }); if (mounted.current) setChecks(result.checks); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setChecking(false); }
  };
  return <div className="dialog-overlay npm-config-overlay" onMouseDown={() => { if (!busy) onClose(); }}><section className="run-config-dialog npm-config-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onMouseDown={(event) => event.stopPropagation()}>
    <header><div><h2 id={`${id}-title`}>npm run configurations</h2><span>{options?.packageJsonPath ?? "Loading project…"}</span></div><button title="Close" disabled={busy} onClick={onClose}><X size={15} /></button></header>
    <div className="npm-config-tabs" role="tablist" aria-label="npm configuration sections">{tabs.map((item) => <button key={item} role="tab" id={`${id}-${item}`} aria-controls={`${id}-panel`} aria-selected={tab === item} onClick={() => setTab(item)}>{item}</button>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="npm-config-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {loading ? <p>Loading configurations…</p> : options && <fieldset disabled={busy || running}>
          <legend className="visually-hidden">npm project settings</legend>
          <div className="npm-config-profile-actions"><select aria-label="Edit npm configuration" value={profile?.id ?? ""} onChange={(event) => setProfileId(event.target.value)}>{!options.runConfigurations.length && <option value="">No configurations yet</option>}{options.runConfigurations.map((item) => <option key={item.id} value={item.id}>{item.name || "Unnamed configuration"}</option>)}</select><button type="button" title="Add configuration" disabled={!targets.length} onClick={() => add(false)}><Plus size={14} /></button><button type="button" title="Duplicate configuration" disabled={!profile} onClick={() => add(true)}><Copy size={14} /></button><button type="button" title="Delete configuration" disabled={!profile} onClick={() => { const remaining = options.runConfigurations.filter((item) => item.id !== profile?.id); setOptions({ ...options, runConfigurations: remaining, selectedRunConfigurationId: options.selectedRunConfigurationId === profile?.id ? remaining[0]?.id : options.selectedRunConfigurationId }); setProfileId(remaining[0]?.id ?? ""); }}><Trash2 size={14} /></button></div>
          {tab === "Tools" ? <><label>Package manager<select value={options.packageManager} onChange={(event) => setOptions({ ...options, packageManager: event.target.value as NpmProjectOptions["packageManager"] })}><option value="npm">npm</option><option value="pnpm">pnpm</option><option value="yarn">Yarn</option></select></label><label>Package manager executable (optional)<input value={options.executable ?? ""} placeholder="npm, pnpm, yarn, or an absolute path" onChange={(event) => setOptions({ ...options, executable: event.target.value || undefined })} /></label><p className="npm-config-help">Use a package manager installed on the Core host. Leave blank to use the selected package manager from PATH.</p><label>Project manifest<input value={options.packageJsonPath} readOnly /></label></> : profile ? <>
            {tab === "Launch" ? <><label className="npm-config-check"><input type="checkbox" checked={options.selectedRunConfigurationId === profile.id} onChange={() => setOptions({ ...options, selectedRunConfigurationId: profile.id })} />Use for Run</label><label>Configuration name<input value={profile.name} onChange={(event) => updateProfile({ name: event.target.value })} /></label><label>Script<select value={profile.script} onChange={(event) => updateProfile({ script: event.target.value })}><option value="" disabled>Choose a script</option>{!targets.some((target) => target.id === profile.script) && profile.script && <option value={profile.script} disabled>{profile.script} (missing from package.json)</option>}{targets.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><div className="npm-command-preview"><code>{options.packageManager} run {profile.script || "<script>"}</code></div><label>Script arguments — one per line<textarea value={drafts[profile.id]?.arguments ?? (profile.arguments ?? []).join("\n")} onChange={(event) => draft("arguments", event.target.value)} placeholder={'--port\n3000'} /></label><p className="npm-config-help">Each line is one argument. Spaces inside an argument are preserved; shell quoting is not needed.</p><label>Node options — one per line<textarea value={drafts[profile.id]?.nodeOptions ?? (profile.nodeOptions ?? []).join("\n")} onChange={(event) => draft("nodeOptions", event.target.value)} placeholder={"--enable-source-maps\n--max-old-space-size=4096"} /></label><label>Working directory (optional)<input value={profile.workingDirectory ?? ""} onChange={(event) => updateProfile({ workingDirectory: event.target.value || undefined })} placeholder="Defaults to the package.json directory" /></label><p className="npm-config-help">Custom paths are relative to the workspace on the Core host.</p></> : <><label>Environment file (optional)<input value={profile.environmentFile ?? ""} onChange={(event) => updateProfile({ environmentFile: event.target.value || undefined })} placeholder="config/development.env" /></label><label>Environment variables — KEY=value<textarea spellCheck={false} value={drafts[profile.id]?.environment ?? environmentText(profile.environment)} onChange={(event) => draft("environment", event.target.value)} placeholder={'NODE_ENV=development\nNODE_OPTIONS=--max-old-space-size=4096'} /></label><p className="npm-config-help">One variable per line. Values override the environment file. Set NODE_OPTIONS for Node runtime flags. Files are relative to the workspace; values are used on the Core host.</p></>}
          </> : <p className="npm-config-help">{targets.length ? "Add a configuration, choose a script, then save to enable Run." : "No scripts found. Add scripts to package.json, then reopen this editor."}</p>}
        </fieldset>}
        {running && <p className="npm-config-help" role="status">Stop this project before changing its configuration.</p>}
        {checks && <div className="npm-tool-checks" role="status">{checks.map((item) => <p key={item.tool} className={item.ok ? "tool-ok" : "tool-failed"}><strong>{item.tool}</strong> {item.message}</p>)}</div>}
        {error && <p className="run-configuration-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" disabled={loading || busy || !options} onClick={() => void check()}>{checking ? "Checking tools…" : "Check tools"}</button><span /><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={loading || busy || running || !options}>{saving ? "Saving…" : "Save configuration"}</button></footer>
    </form>
  </section></div>;
}
