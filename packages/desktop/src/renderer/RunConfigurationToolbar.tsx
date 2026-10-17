import { Bug, Play, Settings, Square } from "lucide-react";
import { runConfigurationKey, type RunProject, type RunProjectProcess } from "./run-projects";
import "./run-configuration-toolbar.css";

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
