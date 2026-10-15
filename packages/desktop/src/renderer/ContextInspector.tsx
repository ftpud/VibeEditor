import { useState, type CSSProperties } from "react";
import type { AiContextCategory, AiSession } from "@remote-ide/protocol";

export type ContextSource = Pick<AiSession, "context" | "contextUsed" | "contextLimit">;
export type ContextUsage = { used: number; limit: number; percent: number };

export function contextUsage(session: ContextSource): ContextUsage | undefined {
  const { contextUsed: used, contextLimit: limit } = session;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used! < 0 || limit! <= 0) return undefined;
  return { used: used!, limit: limit!, percent: Math.min(100, Math.max(0, (used! / limit!) * 100)) };
}

export function ContextUsageIndicator({ session, onClick, expanded, controls }: { session: ContextSource; onClick?(): void; expanded?: boolean; controls?: string }) {
  const value = contextUsage(session);
  if (!value && !onClick) return null;
  const percent = Math.round(value?.percent ?? 0);
  const label = value ? `Context window: ${percent}% used (${value.used.toLocaleString()} of ${value.limit.toLocaleString()} tokens)` : "Context window: usage unavailable";
  const ring = <span className={`ai-context-usage${percent >= 80 ? " near-full" : ""}`} role={onClick ? undefined : "img"} aria-label={onClick ? undefined : label} aria-hidden={onClick ? true : undefined} title={label} style={{ "--context-usage": `${value?.percent ?? 0}%` } as CSSProperties} />;
  return onClick ? <button type="button" className="ai-context-button" aria-label={`Inspect context. ${label}`} title={`Inspect context · ${label}`} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>{ring}</button> : ring;
}

const labels: Record<AiContextCategory, string> = { instructions: "Instructions", conversation: "Prompts & replies", files: "Files & attachments", tools: "Tool activity", reasoning: "Reported reasoning" };

export function ContextInspector({ session, id }: { session: ContextSource; id: string }) {
  const [selected, setSelected] = useState<AiContextCategory>("conversation");
  const snapshot = session.context;
  const sections = snapshot?.sections ?? [];
  const characters = sections.reduce((sum, section) => sum + section.characters, 0);
  const usage = contextUsage(session);
  const history = snapshot?.history ?? [];
  const previous = history.at(-2);
  const latest = history.at(-1);
  const delta = latest && previous ? latest.used - previous.used : undefined;
  const current = sections.find((section) => section.id === selected);
  const scale = Math.max(1, ...history.map((sample) => sample.used));
  return <section id={id} className="context-inspector" aria-label="Context inspector">
    <div className="context-inspector-heading"><strong>Context inspector</strong><span>{usage ? `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens · ${Math.round(usage.percent)}%` : "Provider usage unavailable"}</span></div>
    <div className="context-composition" role="group" aria-label="Captured history composition">
      {sections.filter((section) => section.characters > 0).map((section) => <button type="button" key={section.id} className={`context-color-${section.id}`} style={{ flexGrow: section.characters }} aria-label={`${labels[section.id]}: ${section.characters.toLocaleString()} captured characters`} aria-pressed={selected === section.id} title={`${labels[section.id]} · ≈${Math.ceil(section.characters / 4).toLocaleString()} tokens · ${section.count} items`} onClick={() => setSelected(section.id)} />)}
      {!characters && <span>No captured text yet</span>}
    </div>
    <div className="context-legend">{sections.map((section) => <button type="button" key={section.id} aria-pressed={selected === section.id} onClick={() => setSelected(section.id)}><i className={`context-color-${section.id}`} aria-hidden="true" />{labels[section.id]} <span>≈{Math.ceil(section.characters / 4).toLocaleString()}</span></button>)}</div>
    <small>Captured text: {characters.toLocaleString()} characters · ≈{Math.ceil(characters / 4).toLocaleString()} tokens</small>
    <p className="context-explanation">Bars show captured history, estimated at 4 characters per token, not the model’s exact retained context. Provider system prompt and hidden context are unavailable. Compaction and transcript retention can make these totals differ from provider usage. Images and unresolved file links have no text estimate.</p>
    {history.length > 0 && <div className="context-history"><div><strong>Provider usage over time</strong><span>{history.length} updates{delta !== undefined ? ` · last change ${delta >= 0 ? "+" : ""}${delta.toLocaleString()} tokens` : ""}{snapshot?.compactions ? ` · ${snapshot.compactions} compaction notifications` : ""}</span></div><svg viewBox={`0 0 ${Math.max(1, history.length) * 6} 40`} preserveAspectRatio="none" role="img" aria-label="Provider-reported context token usage history">{history.map((sample, index) => {
      const height = Math.max(1, Math.min(40, sample.used / scale * 40));
      return <rect key={index} x={index * 6} y={40 - height} width="4" height={height}><title>{new Date(sample.timestamp).toLocaleTimeString()} · {sample.used.toLocaleString()}{sample.limit ? ` / ${sample.limit.toLocaleString()}` : ""} tokens · {sample.characters.toLocaleString()} captured characters</title></rect>;
    })}</svg><small>Last {history.length} usage updates, oldest → newest. Auto-scaled to peak usage; hover for values.</small></div>}
    {!snapshot && <p>Capture starts with new session activity. Earlier instructions and tool details may be unavailable.</p>}
    {current && <div className="context-entries"><strong>{labels[selected]} · {current.count} items · {current.characters.toLocaleString()} characters</strong><small>Recent captured items, largest first. Up to 12 previews per category.</small>{[...current.entries].sort((a, b) => b.characters - a.characters).map((item) => <details key={item.id}><summary><span>{item.label}</span><small>{item.characters.toLocaleString()} chars</small></summary><time>{new Date(item.timestamp).toLocaleString()}</time><pre>{item.preview}</pre>{item.characters > item.preview.length && <small>Preview truncated; {item.characters.toLocaleString()} characters were captured.</small>}</details>)}{!current.entries.length && <small>No captured items in this category.</small>}</div>}
  </section>;
}
