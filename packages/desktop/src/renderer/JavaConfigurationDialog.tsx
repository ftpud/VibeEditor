import { useEffect, useRef, useState } from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import type { FileRevision, JavaMainClass, JavaProjectOptions, JavaRunConfiguration, JavaToolCheck } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

type Props = { client: CoreClient; running: boolean; onClose(): void; onSaved(options: JavaProjectOptions): void };
const lines = (value: string) => value.split(/\r?\n/).filter((item) => item.trim());

function formOptions(content: string): JavaProjectOptions {
  const value = JSON.parse(content) as JavaProjectOptions;
  if (!value || typeof value !== "object" || value.type !== "maven" || typeof value.mavenExecutable !== "string" || typeof value.pomPath !== "string" || typeof value.outputPath !== "string" || typeof value.testOutputPath !== "string" || !Array.isArray(value.sourceRoots) || !value.sourceRoots.every((item) => typeof item === "string") || !Array.isArray(value.runConfigurations) || !value.runConfigurations.every((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.mainClass === "string")) throw new Error("Use the template to include Maven settings, project paths, and a runConfigurations array before switching to the form.");
  for (const list of [value.mavenArguments, value.buildGoals, ...value.runConfigurations.flatMap((item) => [item.vmArguments, item.programArguments])]) if (list !== undefined && (!Array.isArray(list) || !list.every((item) => typeof item === "string"))) throw new Error("Arguments and build goals must be JSON arrays of strings.");
  return value;
}

export function JavaConfigurationDialog({ client, running, onClose, onSaved }: Props) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [content, setContent] = useState("");
  const [template, setTemplate] = useState("");
  const [revision, setRevision] = useState<FileRevision>();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [classes, setClasses] = useState<JavaMainClass[]>([]);
  const [profileId, setProfileId] = useState("");
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({});
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<JavaToolCheck[]>();
  const [error, setError] = useState("");
  let options: JavaProjectOptions | undefined;
  try { if (content) options = formOptions(content); } catch { /* Preserve malformed JSON for repair in the JSON editor. */ }
  const profile = options?.runConfigurations.find((item) => item.id === profileId) ?? options?.runConfigurations[0];
  const busy = saving || checking;

  useEffect(() => {
    let current = true;
    void client.request("java.configuration.read", {}).then((result) => {
      if (!current) return;
      setContent(result.content); setTemplate(result.template); setRevision(result.revision);
      try { const value = formOptions(result.content); setProfileId(value.selectedRunConfigurationId ?? value.runConfigurations[0]?.id ?? ""); }
      catch (loadError) { setMode("json"); setError(loadError instanceof Error ? loadError.message : "Repair the configuration JSON"); }
    }).catch((loadError: unknown) => { if (current) setError(loadError instanceof Error ? loadError.message : "Could not read Java configuration"); })
      .finally(() => { if (current) setLoading(false); });
    void client.request("java.listMainClasses", {}).then((result) => { if (current) setClasses(result.classes); }).catch(() => undefined);
    return () => { current = false; };
  }, [client]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [busy, onClose]);

  const update = (value: JavaProjectOptions) => { setContent(JSON.stringify(value, null, 2) + "\n"); setChecks(undefined); setError(""); };
  const editArguments = (key: string, value: string, saveValue: (items: string[]) => void) => { setArgumentDrafts((current) => ({ ...current, [key]: value })); saveValue(lines(value)); };
  const updateProfile = (value: Partial<JavaRunConfiguration>) => {
    if (options && profile) update({ ...options, runConfigurations: options.runConfigurations.map((item) => item.id === profile.id ? { ...item, ...value } : item) });
  };
  const draftContent = () => {
    if (mode === "json") return content;
    const value = formOptions(content);
    const profiles = value.runConfigurations.map((item) => {
      if (environmentDrafts[item.id] === undefined) return item;
      let environment: unknown;
      try { environment = JSON.parse(environmentDrafts[item.id]!); }
      catch { throw new Error(`${item.name}: application environment must be a JSON object, such as {"MODE":"development"}`); }
      if (!environment || typeof environment !== "object" || Array.isArray(environment) || !Object.values(environment).every((entry) => typeof entry === "string")) throw new Error(`${item.name}: environment values must be strings`);
      return { ...item, environment: environment as Record<string, string> };
    });
    return JSON.stringify({ ...value, runConfigurations: profiles }, null, 2) + "\n";
  };
  const switchMode = (next: "form" | "json") => {
    try {
      const draft = draftContent();
      if (next === "form") formOptions(draft);
      setContent(draft); setEnvironmentDrafts({}); setArgumentDrafts({}); setMode(next); setError("");
    } catch (switchError) { setError(switchError instanceof Error ? switchError.message : String(switchError)); }
  };
  const addProfile = (duplicate = false) => {
    if (!options) return;
    const id = crypto.randomUUID();
    const next: JavaRunConfiguration = duplicate && profile ? { ...profile, id, name: `${profile.name} copy`, environment: environmentDrafts[profile.id] ? JSON.parse(environmentDrafts[profile.id]!) : profile.environment } : { id, name: "Application", mainClass: classes[0]?.className ?? "", programArguments: [], vmArguments: [], workingDirectory: ".", environment: {} };
    update({ ...options, runConfigurations: [...options.runConfigurations, next], selectedRunConfigurationId: options.selectedRunConfigurationId ?? id });
    setProfileId(id);
  };
  const save = async () => {
    if (busy || running) return;
    setSaving(true); setError("");
    try { const result = await client.request("java.configuration.save", { content: draftContent(), expectedRevision: revision }); if (mounted.current) onSaved(result.options); }
    catch (saveError) { if (mounted.current) setError(saveError instanceof Error ? saveError.message : "Could not save Java configuration"); }
    finally { if (mounted.current) setSaving(false); }
  };
  const check = async () => {
    setChecking(true); setChecks(undefined); setError("");
    try { const result = await client.request("java.tools.check", { content: draftContent() }); if (mounted.current) setChecks(result.checks); }
    catch (checkError) { if (mounted.current) setError(checkError instanceof Error ? checkError.message : "Could not check Java tools"); }
    finally { if (mounted.current) setChecking(false); }
  };

  return <div className="dialog-overlay" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="run-config-dialog java-config-dialog" role="dialog" aria-modal="true" aria-label="Java run/debug configuration" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2>Java run/debug configuration</h2><span>Saved in .vibe/java.json on the Core host</span></div><button title="Close" disabled={busy} onClick={onClose}><X size={15} /></button></header>
      <div className="java-config-tabs" role="tablist" aria-label="Configuration editor">
        <button role="tab" aria-selected={mode === "form"} disabled={loading || busy} onClick={() => switchMode("form")}>Settings &amp; profiles</button>
        <button role="tab" aria-selected={mode === "json"} disabled={loading || busy} onClick={() => switchMode("json")}>JSON</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="java-config-body">
          <p className="java-config-help">Maven and Java run on the Core host. Use paths on that machine. The same launch profile works for Run and Debug.</p>
          {running && <p role="status" className="java-config-help">Stop the Java process before saving configuration changes.</p>}
          {loading ? <p>Loading configuration…</p> : mode === "json" ? <>
            <button type="button" disabled={busy} onClick={() => { setContent(template); setEnvironmentDrafts({}); setArgumentDrafts({}); setChecks(undefined); setError(""); }}>Insert template</button>
            <label>Configuration JSON<textarea className="java-config-json" spellCheck={false} value={content} disabled={busy} onChange={(event) => { setContent(event.target.value); setChecks(undefined); }} /></label>
          </> : options && <>
            <fieldset disabled={busy}><legend>Tools and build</legend>
              <label>Maven executable<input autoFocus value={options.mavenExecutable} onChange={(event) => update({ ...options!, mavenExecutable: event.target.value })} placeholder="mvn, ./mvnw, or /opt/maven/bin/mvn" /></label>
              <p className="java-config-help">Use ./mvnw when the project contains a Maven wrapper, or enter the installed Maven executable. Put extra flags below, not in this field.</p>
              <label>JDK home (optional)<input value={options.javaHome ?? ""} onChange={(event) => update({ ...options!, javaHome: event.target.value })} placeholder="/usr/lib/jvm/java-21-openjdk" /></label>
              <p className="java-config-help">The JDK directory, not its bin/java executable. Blank uses the Core host’s JAVA_HOME or PATH.</p>
              <div className="java-config-grid">
                <label>Maven arguments — one per line<textarea value={argumentDrafts.maven ?? (options.mavenArguments ?? []).join("\n")} onChange={(event) => editArguments("maven", event.target.value, (items) => update({ ...options!, mavenArguments: items }))} placeholder={"-Pdevelopment\n-DskipTests"} /></label>
                <label>Build goals / flags — one per line<textarea value={argumentDrafts.goals ?? (options.buildGoals ?? ["package", "-DskipTests"]).join("\n")} onChange={(event) => editArguments("goals", event.target.value, (items) => update({ ...options!, buildGoals: items }))} /></label>
              </div>
            </fieldset>
            <fieldset disabled={busy}><legend>Launch profiles</legend>
              <div className="java-config-profile-actions"><select aria-label="Edit launch profile" value={profile?.id ?? ""} onChange={(event) => setProfileId(event.target.value)}>{!options.runConfigurations.length && <option value="">No profiles yet</option>}{options.runConfigurations.map((item) => <option key={item.id} value={item.id}>{item.name || "Unnamed profile"}</option>)}</select>
                <button type="button" title="Add launch profile" onClick={() => addProfile()}><Plus size={14} />Add</button>
                <button type="button" title="Duplicate launch profile" disabled={!profile} onClick={() => { try { addProfile(true); } catch { setError("Fix the environment JSON before duplicating this profile."); } }}><Copy size={14} /></button>
                <button type="button" title="Delete launch profile" disabled={!profile} onClick={() => { const remaining = options!.runConfigurations.filter((item) => item.id !== profile!.id); update({ ...options!, runConfigurations: remaining, selectedRunConfigurationId: options!.selectedRunConfigurationId === profile!.id ? remaining[0]?.id : options!.selectedRunConfigurationId }); setProfileId(remaining[0]?.id ?? ""); }}><Trash2 size={14} /></button>
              </div>
              {profile ? <>
                <label className="java-config-check"><input type="checkbox" checked={options.selectedRunConfigurationId === profile.id} onChange={() => update({ ...options!, selectedRunConfigurationId: profile.id })} />Use this profile for Run / Debug</label>
                <label>Profile name<input value={profile.name} onChange={(event) => updateProfile({ name: event.target.value })} /></label>
                <label>Main class<input list="java-main-class-options" value={profile.mainClass} onChange={(event) => updateProfile({ mainClass: event.target.value })} placeholder="com.example.App" /><datalist id="java-main-class-options">{classes.map((item) => <option key={item.className} value={item.className} />)}</datalist></label>
                <div className="java-config-grid">
                  <label>Program arguments — one per line<textarea value={argumentDrafts[`${profile.id}-program`] ?? (profile.programArguments ?? []).join("\n")} onChange={(event) => editArguments(`${profile.id}-program`, event.target.value, (items) => updateProfile({ programArguments: items }))} placeholder={"--port\n8080"} /></label>
                  <label>VM arguments — one per line<textarea value={argumentDrafts[`${profile.id}-vm`] ?? (profile.vmArguments ?? []).join("\n")} onChange={(event) => editArguments(`${profile.id}-vm`, event.target.value, (items) => updateProfile({ vmArguments: items }))} placeholder={"-ea\n-Xmx1g\n-Dapp.mode=development"} /></label>
                </div>
                <p className="java-config-help">Each line is one argument. Spaces inside a line are preserved; no shell quoting is needed. JSON also supports empty arguments.</p>
                <label>Working directory<input value={profile.workingDirectory ?? "."} onChange={(event) => updateProfile({ workingDirectory: event.target.value })} placeholder=". (workspace root)" /></label>
                <label>Environment file (.env, optional)<input value={profile.environmentFile ?? ""} onChange={(event) => updateProfile({ environmentFile: event.target.value.trim() || undefined })} placeholder="config/app.env" /></label>
                <p className="java-config-help">Path relative to the workspace on the Core host. Use .env format: KEY=value, one variable per line. Loaded for each Run / Debug; values below override file values.</p>
                <label>Application environment (JSON)<textarea spellCheck={false} value={environmentDrafts[profile.id] ?? JSON.stringify(profile.environment ?? {}, null, 2)} onChange={(event) => { setEnvironmentDrafts((current) => ({ ...current, [profile.id]: event.target.value })); setChecks(undefined); }} placeholder={'{"MODE":"development"}'} /></label>
              </> : <p className="java-config-help">Add a profile, choose its main class, then save to enable Run and Debug.</p>}
            </fieldset>
            <details><summary>Project paths</summary><fieldset disabled={busy}>
              <label>Maven project file<input value={options.pomPath} onChange={(event) => update({ ...options!, pomPath: event.target.value })} /></label>
              <label>Source roots — one per line<textarea value={argumentDrafts.sources ?? options.sourceRoots.join("\n")} onChange={(event) => editArguments("sources", event.target.value, (items) => update({ ...options!, sourceRoots: items }))} /></label>
              <label>Compiled classes<input value={options.outputPath} onChange={(event) => update({ ...options!, outputPath: event.target.value })} /></label>
              <label>Compiled test classes<input value={options.testOutputPath} onChange={(event) => update({ ...options!, testOutputPath: event.target.value })} /></label>
            </fieldset></details>
          </>}
          {checks && <div className="java-tool-checks" role="status">{checks.map((item) => <div key={item.tool} className={item.ok ? "tool-ok" : "tool-failed"}><strong>{item.ok ? "✓" : "✗"} {item.tool}</strong><code>{item.executable}</code><p>{item.message}</p></div>)}</div>}
          {error && <div className="find-error" role="alert">{error}</div>}
        </div>
        <footer><button type="button" disabled={loading || busy || !content} onClick={() => void check()}>{checking ? "Checking tools…" : "Check tools"}</button><span /><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={loading || busy || running || !content}>{saving ? "Saving…" : "Save configuration"}</button></footer>
      </form>
    </section>
  </div>;
}
