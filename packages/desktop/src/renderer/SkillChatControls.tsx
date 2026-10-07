import { useState } from "react";
import type { SkillFile } from "@remote-ide/protocol";

type SkillSelectionProps = { skills: SkillFile[]; selected: string[]; disabled?: boolean; onChange(ids: string[]): Promise<void> };

function useSkillSelection({ skills, selected, onChange }: SkillSelectionProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const enabled = skills.filter((skill) => selected.includes(skill.id));
  const update = async (ids: string[]) => { setSaving(true); setError(""); try { await onChange(ids.filter((id) => skills.some((skill) => skill.id === id))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change skills"); } finally { setSaving(false); } };
  return { saving, error, enabled, update };
}

export function SkillChatChips(props: SkillSelectionProps) {
  const { saving, error, enabled, update } = useSkillSelection(props);
  if (!enabled.length) return null;
  return <div className="skill-chat-enabled" role="group" aria-label="Enabled chat skills">
    {enabled.map((skill) => <button className="skill-chip" key={skill.id} aria-label={`Disable ${skill.title}`} disabled={props.disabled || saving} onClick={() => void update(props.selected.filter((id) => id !== skill.id))}>{skill.title} ×</button>)}
    {error && <span role="alert" className="inline-error">{error}</span>}
  </div>;
}

export function SkillChatControls({ running, onOpen, ...props }: SkillSelectionProps & { running: boolean; onOpen(): void }) {
  const { skills, selected, disabled } = props;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { saving, error, enabled, update } = useSkillSelection(props);
  return <div className="skill-chat-controls" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); event.stopPropagation(); event.currentTarget.querySelector<HTMLButtonElement>(".skill-chat-trigger")?.focus(); } }}>
    <button className={`skill-chat-trigger${open ? " active" : ""}`} aria-label={`Skills · ${enabled.length} active`} title={`${enabled.length} skills enabled`} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>Skills <span className={`skill-count${enabled.length ? " enabled" : ""}`} aria-hidden="true">{enabled.length}</span></button>
    {open && <div className="skill-chat-picker"><input aria-label="Search chat skills" placeholder="Search skills" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {skills.filter((skill) => `${skill.title} ${skill.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map((skill) => <label key={skill.id} title={skill.description}><input type="checkbox" aria-label={`Enable ${skill.title} for chat`} checked={selected.includes(skill.id)} disabled={disabled || saving} onChange={(event) => void update(event.target.checked ? [...selected, skill.id] : selected.filter((id) => id !== skill.id))} />{skill.title}<small>{skill.scope}</small></label>)}
      {!skills.length && <small>No skills allowed in this project.</small>}
      <small>{running ? "Applies next turn. " : ""}Disabling skills leaves earlier instructions in chat history.</small>
      {error && <span role="alert" className="inline-error">{error}</span>}
      <button onClick={onOpen}>Manage skills</button>
    </div>}
  </div>;
}
