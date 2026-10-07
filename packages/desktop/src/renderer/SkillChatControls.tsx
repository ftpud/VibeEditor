import { useState } from "react";
import type { SkillFile } from "@remote-ide/protocol";

export function SkillChatControls({ skills, selected, running, disabled, onChange, onOpen }: { skills: SkillFile[]; selected: string[]; running: boolean; disabled?: boolean; onChange(ids: string[]): Promise<void>; onOpen(): void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const enabled = skills.filter((skill) => selected.includes(skill.id));
  const update = async (ids: string[]) => { setSaving(true); setError(""); try { await onChange(ids.filter((id) => skills.some((skill) => skill.id === id))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change skills"); } finally { setSaving(false); } };
  return <div className="skill-chat-controls">
    <button aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>Skills · {enabled.length} active</button>
    {enabled.map((skill) => <button className="skill-chip" key={skill.id} aria-label={`Disable ${skill.title}`} disabled={disabled || saving} onClick={() => void update(selected.filter((id) => id !== skill.id))}>{skill.title} ×</button>)}
    {error && <span role="alert" className="inline-error">{error}</span>}
    {open && <div className="skill-chat-picker"><input aria-label="Search chat skills" placeholder="Search skills" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {skills.filter((skill) => `${skill.title} ${skill.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map((skill) => <label key={skill.id} title={skill.description}><input type="checkbox" aria-label={`Enable ${skill.title} for chat`} checked={selected.includes(skill.id)} disabled={disabled || saving} onChange={(event) => void update(event.target.checked ? [...selected, skill.id] : selected.filter((id) => id !== skill.id))} />{skill.title}<small>{skill.scope}</small></label>)}
      {!skills.length && <small>No skills allowed in this project.</small>}
      <small>{running ? "Applies next turn. " : ""}Disabling skills leaves earlier instructions in chat history.</small>
      <button onClick={onOpen}>Manage skills</button>
    </div>}
  </div>;
}
