import { useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { skillAllowedForAgent } from "@remote-ide/protocol";
import type { AgentFile, AiAgentPreset, SkillCatalog, SkillPolicy, SkillScope } from "@remote-ide/protocol";

export type SkillsActions = {
  read(id: string): Promise<string>;
  write(id: string, content: string): Promise<void>;
  delete(id: string): Promise<void>;
  policy(policy: SkillPolicy): Promise<void>;
};
const template = "---\nname: New Skill\ndescription: Describe when to use this skill.\n---\n\nDescribe the workflow and instructions here.\n";

export function SkillsPanel({ agents = [], agentPreset, catalog, selected, running, disabled, onRefresh, onSelection, actions }: { agents?: AgentFile[]; agentPreset?: AiAgentPreset | null; catalog: SkillCatalog; selected: string[]; running: boolean; disabled?: boolean; onRefresh(): Promise<void>; onSelection(ids: string[]): Promise<void>; actions: SkillsActions }) {
  const [filter, setFilter] = useState("");
  const [editor, setEditor] = useState<{ id: string; content: string; creating: boolean }>();
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
    <div className="skills-panel">
      <input aria-label="Filter skills" placeholder="Filter skills" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <p>{running ? "Changes apply to the next turn." : "Enable skills for this chat."} Defaults apply to new chats.</p>
      {error && <div role="alert" className="inline-error">{error}</div>}
      {(["global", "local"] as SkillScope[]).map((scope) => <section key={scope}>
        <header><strong>{scope === "global" ? "Global" : "Local"}</strong><button title={`Create ${scope} skill`} disabled={busy || disabled} onClick={() => setEditor({ id: `${scope}/`, content: template, creating: true })}><Plus size={13} /></button></header>
        {catalog.skills.filter((skill) => skill.scope === scope && `${skill.title} ${skill.id} ${skill.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map((skill) => {
          const allowed = catalog.policy.allowed.includes(skill.id);
          const usable = skillAllowedForAgent(catalog.policy, skill.id, agentPreset);
          const assignments = catalog.policy.agents?.[skill.id];
          return <div className="skill-row" key={skill.id}>
            <label><input type="checkbox" aria-label={`Enable ${skill.title}`} checked={usable && selected.includes(skill.id)} disabled={!usable || busy || disabled} onChange={(event) => void perform(() => onSelection((event.target.checked ? [...selected, skill.id] : selected.filter((id) => id !== skill.id)).filter((id) => skillAllowedForAgent(catalog.policy, id, agentPreset) && catalog.skills.some((item) => item.id === id))))} /><strong>{skill.title}</strong></label>
            <small>{skill.description ?? skill.id}</small>
            <div className="skill-controls"><label><input type="checkbox" aria-label={`Allow ${skill.title} in project`} checked={allowed} disabled={busy || disabled} onChange={(event) => void changePolicy(skill.id, "allowed", event.target.checked)} /> Allowed</label><label><input type="checkbox" aria-label={`Use ${skill.title} by default`} checked={catalog.policy.defaults.includes(skill.id)} disabled={!allowed || busy || disabled} onChange={(event) => void changePolicy(skill.id, "defaults", event.target.checked)} /> Default</label><button disabled={busy || disabled} onClick={() => void perform(async () => setEditor({ id: skill.id, content: await actions.read(skill.id), creating: false }))}>Edit</button></div>
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
          </div>;
        })}
        {!catalog.skills.some((skill) => skill.scope === scope) && <small>No {scope} skills. Create one to get started.</small>}
      </section>)}
      {editor && <section className="skill-editor"><header><strong>{editor.creating ? "Create skill" : editor.id}</strong><button title="Close skill editor" disabled={busy} onClick={() => setEditor(undefined)}><X size={13} /></button></header>
        {editor.creating && <input aria-label="Skill ID" placeholder="local/reviewer" value={editor.id} onChange={(event) => setEditor({ ...editor, id: event.target.value })} />}
        <textarea aria-label="Skill instructions" value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} />
        <button disabled={busy || disabled} onClick={() => void perform(async () => {
          if (editor.creating && catalog.skills.some((skill) => skill.id === editor.id)) throw new Error("A skill with this ID already exists");
          await actions.write(editor.id, editor.content); setEditor(undefined);
        })}>Save</button>
        {!editor.creating && <button disabled={busy || disabled} onClick={() => void perform(async () => { await actions.delete(editor.id); setEditor(undefined); })}>Delete instructions</button>}
      </section>}
    </div>
  </>;
}
