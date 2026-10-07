import { useState } from "react";
import { BookOpen, Pencil, Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { skillAllowedForAgent } from "@remote-ide/protocol";
import type { AgentFile, AiAgentPreset, SkillCatalog, SkillPolicy, SkillScope } from "@remote-ide/protocol";

export type SkillsActions = {
  write(id: string, content: string): Promise<void>;
  delete(id: string): Promise<void>;
  policy(policy: SkillPolicy): Promise<void>;
};
const template = "---\nname: New Skill\ndescription: Describe when to use this skill.\n---\n\nDescribe the workflow and instructions here.\n";

export function SkillsPanel({ agents = [], agentPreset, catalog, selected, running, disabled, onRefresh, onSelection, onOpen, activeSkillId, actions }: { agents?: AgentFile[]; agentPreset?: AiAgentPreset | null; catalog: SkillCatalog; selected: string[]; running: boolean; disabled?: boolean; onRefresh(): Promise<void>; onSelection(ids: string[]): Promise<void>; onOpen(id: string, mode: "edit" | "preview"): Promise<void>; activeSkillId?: string; actions: SkillsActions }) {
  const [settingsId, setSettingsId] = useState<string>();
  const [creation, setCreation] = useState<{ id: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const perform = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update skills"); } finally { setBusy(false); } };
  const changePolicy = (id: string, kind: "allowed" | "defaults", checked: boolean) => perform(async () => {
    const policy: SkillPolicy = { ...catalog.policy, allowed: [...catalog.policy.allowed], defaults: [...catalog.policy.defaults] };
    policy[kind] = checked ? [...new Set([...policy[kind], id])] : policy[kind].filter((value) => value !== id);
    if (kind === "allowed" && !checked) policy.defaults = policy.defaults.filter((value) => value !== id);
    await actions.policy(policy);
  });
  const changeAgents = (id: string, choices: (AiAgentPreset | null)[] | undefined) => perform(async () => {
    const assignments = { ...catalog.policy.agents };
    if (choices === undefined) delete assignments[id]; else assignments[id] = choices;
    await actions.policy({ ...catalog.policy, agents: assignments });
  });
  return <>
    <header className="panel-header"><span>Skills</span><button title="Refresh skills" disabled={busy || disabled} onClick={() => void perform(onRefresh)}><RefreshCw size={14} /></button></header>
    <div className="useful-files-list skills-list">
      {error && <div role="alert" className="inline-error">{error}</div>}
      {(["global", "local"] as SkillScope[]).map((scope) => <section key={scope} className="useful-section">
        <header><span>{scope === "global" ? "Global" : "Local"}</span><button title={`Create ${scope} skill`} disabled={busy || disabled} onClick={() => setCreation({ id: `${scope}/` })}><Plus size={14} /></button></header>
        {catalog.skills.filter((skill) => skill.scope === scope).map((skill) => {
          const allowed = catalog.policy.allowed.includes(skill.id);
          const usable = skillAllowedForAgent(catalog.policy, skill.id, agentPreset);
          const assignments = catalog.policy.agents?.[skill.id];
          const open = (mode: "edit" | "preview") => perform(() => onOpen(skill.id, mode));
          return <div key={skill.id}>
            <div className={`useful-row ${activeSkillId === skill.id || settingsId === skill.id ? "selected" : ""}`}>
              <button className="useful-open" title={skill.description ?? skill.title} disabled={busy || disabled} onClick={() => void open("preview")}><BookOpen className="agent-kind-icon" size={14} /><span>{skill.title}</span></button>
              <button title={`Settings for ${skill.title}`} aria-expanded={settingsId === skill.id} disabled={busy || disabled} onClick={() => setSettingsId(settingsId === skill.id ? undefined : skill.id)}><Settings2 size={12} /></button>
              <button title={`Edit ${skill.title}`} disabled={busy || disabled} onClick={() => void open("edit")}><Pencil size={12} /></button>
              <button title={`Delete ${skill.title}`} disabled={busy || disabled} onClick={() => void perform(async () => { await actions.delete(skill.id); if (settingsId === skill.id) setSettingsId(undefined); })}><Trash2 size={12} /></button>
            </div>
            {settingsId === skill.id && <div className="skill-settings">
            <p>{running ? "Changes apply to the next turn." : "Enable skills for this chat."} Defaults apply to new chats.</p>
            <label><input type="checkbox" aria-label={`Enable ${skill.title}`} checked={usable && selected.includes(skill.id)} disabled={!usable || busy || disabled} onChange={(event) => void perform(() => onSelection((event.target.checked ? [...selected, skill.id] : selected.filter((id) => id !== skill.id)).filter((id) => skillAllowedForAgent(catalog.policy, id, agentPreset) && catalog.skills.some((item) => item.id === id))))} /><strong>{skill.title}</strong></label>
            {skill.description && <small>{skill.description}</small>}
            <div className="skill-controls"><label><input type="checkbox" aria-label={`Allow ${skill.title} in project`} checked={allowed} disabled={busy || disabled} onChange={(event) => void changePolicy(skill.id, "allowed", event.target.checked)} /> Allowed</label><label><input type="checkbox" aria-label={`Use ${skill.title} by default`} checked={catalog.policy.defaults.includes(skill.id)} disabled={!allowed || busy || disabled} onChange={(event) => void changePolicy(skill.id, "defaults", event.target.checked)} /> Default</label></div>
            <details className="skill-agent-access"><summary aria-label={`Agent access for ${skill.title}`}>Agents: {assignments === undefined ? "Any agent" : assignments.length === 0 ? "None allowed" : `${assignments.length} selected`}</summary>
              <label><input type="checkbox" aria-label={`Any agent for ${skill.title}`} checked={assignments === undefined} disabled={busy || disabled} onChange={(event) => void changeAgents(skill.id, event.target.checked ? undefined : [])} /> Any agent</label>
              <label><input type="checkbox" aria-label={`No agent for ${skill.title}`} checked={assignments === undefined || assignments.includes(null)} disabled={busy || disabled} onChange={(event) => {
                const choices = assignments ?? [null, ...agents.map((file) => ({ scope: file.scope, name: file.name }))];
                void changeAgents(skill.id, event.target.checked ? [...choices.filter((choice) => choice !== null), null] : choices.filter((choice) => choice !== null));
              }} /> No agent</label>
              {agents.map((file) => {
                const included = assignments === undefined || assignments.some((choice) => choice?.scope === file.scope && choice.name === file.name);
                return <label key={`${file.scope}/${file.name}`}><input type="checkbox" aria-label={`Allow ${file.agent.name} (${file.scope}) to use ${skill.title}`} checked={included} disabled={busy || disabled} onChange={(event) => {
                  const choices = assignments ?? [null, ...agents.map((item) => ({ scope: item.scope, name: item.name }))];
                  const rest = choices.filter((choice) => choice?.scope !== file.scope || choice.name !== file.name);
                  void changeAgents(skill.id, event.target.checked ? [...rest, { scope: file.scope, name: file.name }] : rest);
                }} />{file.agent.name} <small>{file.scope}</small></label>;
              })}
            </details>
            {!usable && allowed && <small>Unavailable for the current agent.</small>}
            </div>}
          </div>;
        })}
        {!catalog.skills.some((skill) => skill.scope === scope) && <div className="useful-empty">No skills</div>}
      </section>)}
    </div>
    {creation && <div className="dialog-overlay" onMouseDown={() => { if (!busy) setCreation(undefined); }}>
      <section className="run-config-dialog useful-file-dialog" role="dialog" aria-modal="true" aria-label="Create skill" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2>Create Skill</h2><span>{creation.id.startsWith("global/") ? "Global" : "Local"}</span></div><button title="Close skill creation" disabled={busy} onClick={() => setCreation(undefined)}><X size={15} /></button></header>
        <form onSubmit={(event) => { event.preventDefault(); void perform(async () => {
          if (catalog.skills.some((skill) => skill.id === creation.id)) throw new Error("A skill with this ID already exists");
          await actions.write(creation.id, template);
          setCreation(undefined);
          await onOpen(creation.id, "edit");
        }); }}>
          <label>Skill ID<input autoFocus aria-label="Skill ID" placeholder="local/reviewer" disabled={busy} value={creation.id} onChange={(event) => setCreation({ id: event.target.value })} /></label>
          <small>A Markdown skill template will be created and opened in the editor.</small>
          {error && <div className="find-error">{error}</div>}
          <footer><button type="button" disabled={busy} onClick={() => setCreation(undefined)}>Cancel</button><button className="primary" disabled={busy || disabled || !/^(global|local)\/.+/.test(creation.id)}>Create</button></footer>
        </form>
      </section>
    </div>}
  </>;
}
