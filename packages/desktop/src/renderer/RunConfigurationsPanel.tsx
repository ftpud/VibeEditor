import { useEffect, useRef } from "react";
import { Bug, ChevronDown, Play, Plus, RefreshCw, Settings, Square, X } from "lucide-react";
import { runConfigurationKey, type RunProject, type RunProjectProcess } from "./run-projects";
import "./run-configurations.css";

type Actions = {
  projects: RunProject[];
  selectedLanguage?: string;
  processes: Record<string, RunProjectProcess>;
  busy?: boolean;
  onSelect(language: string, id: string): void;
  onConfigure(language: string): void;
  onRun(language: string, debug?: boolean): void;
  onStop(language: string): void;
};
const idle: RunProjectProcess = { running: false, log: "" };

export function RunConfigurationToolbar({ projects, selectedLanguage, processes, busy, onSelect, onConfigure, onRun, onStop }: Actions) {
  const project = projects.find((item) => item.language === selectedLanguage) ?? projects[0];
  if (!project) return null;
  const process = processes[project.language] ?? idle;
  const selected = project.configurations.find((item) => item.id === project.selectedId);
  return <div className="top-java-run project-run-toolbar" role="toolbar" aria-label="Run configuration controls">
    <button aria-label="Run selected configuration" title="Run selected configuration" disabled={busy || process.running || !selected} onClick={() => onRun(project.language)}><Play size={14} /></button>
    {project.capabilities.debug && <button aria-label="Debug selected configuration" title="Debug selected configuration" disabled={busy || process.running || !selected} onClick={() => onRun(project.language, true)}><Bug size={14} /></button>}
    <button aria-label="Stop selected project" title="Stop selected project" disabled={!process.running} onClick={() => onStop(project.language)}><Square size={13} /></button>
    <select aria-label="Run configuration" disabled={busy} value={selected ? runConfigurationKey(project.language, selected.id) : ""} onChange={(event) => {
      for (const item of projects) {
        const configuration = item.configurations.find((configuration) => runConfigurationKey(item.language, configuration.id) === event.target.value);
        if (configuration) { onSelect(item.language, configuration.id); return; }
      }
    }}>
      <option value="" disabled>Select run configuration</option>
      {projects.map((item) => <optgroup key={item.language} label={item.name}>{item.configurations.map((configuration) => <option key={configuration.id} value={runConfigurationKey(item.language, configuration.id)} disabled={processes[item.language]?.running}>{configuration.name}</option>)}</optgroup>)}
    </select>
    <button aria-label="Edit run configurations" title="Edit run configurations" onClick={() => onConfigure(project.language)}><Settings size={14} /></button>
  </div>;
}

export function RunConfigurationsPanel(props: Actions & { onClose(): void; onRefresh(): void; onClear(language: string): void }) {
  const { projects, selectedLanguage, processes, busy, onSelect, onConfigure, onRun, onStop, onClose, onRefresh, onClear } = props;
  const project = projects.find((item) => item.language === selectedLanguage) ?? projects[0];
  const process = project ? processes[project.language] ?? idle : idle;
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [process.log]);
  return <section className="run-configurations-panel stacked-panel" aria-label="Run Configurations">
    <header className="panel-header"><span>Run Configurations</span><div className="panel-header-actions"><button title="Refresh run configurations" disabled={busy} onClick={onRefresh}><RefreshCw size={14} /></button><button title="Close Run Configurations" onClick={onClose}><X size={14} /></button></div></header>
    <div className="run-configurations-body">
      {!projects.length ? <div className="run-configurations-empty"><Play size={24} /><h3>Add a project to get started</h3><p>In Project, right-click <code>package.json</code> and choose <strong>Add as npm project</strong>, or <code>pom.xml</code> and choose <strong>Add as Maven project</strong>.</p><p>Then create a named configuration for each command or application you run.</p></div> : <>
        <div className="run-project-list">{projects.map((item) => <section key={item.language} className="run-project-group"><header><div><strong>{item.name}</strong>{item.path && <small title={item.path}>{item.path}</small>}</div><button title={`Edit ${item.name} configurations`} disabled={busy || processes[item.language]?.running} onClick={() => onConfigure(item.language)}><Settings size={14} /></button></header>
          {!item.configurations.length ? <button className="run-config-add" onClick={() => onConfigure(item.language)}><Plus size={14} />Add configuration</button> : item.configurations.map((configuration) => {
            const active = project?.language === item.language && item.selectedId === configuration.id;
            return <button key={configuration.id} className={`run-configuration-row ${active ? "selected" : ""}`} aria-pressed={active} disabled={busy || processes[item.language]?.running} onClick={() => onSelect(item.language, configuration.id)}><Play size={13} /><span>{configuration.name}</span>{active && <small>Selected</small>}</button>;
          })}
        </section>)}</div>
        {project && <div className="run-selection-actions"><button className="run-primary" disabled={busy || process.running || !project.selectedId} onClick={() => onRun(project.language)}><Play size={14} />Run</button>{project.capabilities.debug && <button disabled={busy || process.running || !project.selectedId} onClick={() => onRun(project.language, true)}><Bug size={14} />Debug</button>}<button disabled={!process.running} onClick={() => onStop(project.language)}><Square size={14} />Stop</button><button title="Edit run configurations" disabled={busy || process.running} onClick={() => onConfigure(project.language)}><Settings size={14} /></button></div>}
      </>}
      {process.error && <p className="run-configuration-error" role="alert">{process.error}</p>}
      {project && <details className="run-project-output" open={process.running || !!process.log}><summary><ChevronDown size={13} />Output <span>{process.running ? "Running" : "Idle"}</span></summary><button className="run-output-clear" onClick={() => onClear(project.language)}>Clear output</button><pre ref={output} aria-label={`${project.name} output`}>{process.log || "Output appears here when you run a configuration."}</pre></details>}
    </div>
  </section>;
}
