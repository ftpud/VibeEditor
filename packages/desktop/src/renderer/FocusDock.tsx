import { readSetting, writeSetting } from "./settings";
import { ChevronDown, ChevronLeft, ChevronRight, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

type DockMode = "bubble" | "pinned" | "auto-hide";
type Edge = "left" | "right" | "bottom";

/** Keep the original tools mounted as their rail folds into an edge bubble. */
export function FocusDock({ edge, active, children }: { edge: Edge; active: boolean; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const setting = `focusDock.${edge}`;
  const [mode, setMode] = useState<DockMode>(() => {
    const saved = readSetting(setting);
    return saved === "pinned" || saved === "auto-hide" ? saved : "bubble";
  });
  const changeMode = (next: DockMode) => { setMode(next); writeSetting(setting, next); };
  const pinned = mode === "pinned";
  const autoHide = mode === "auto-hide";
  const id = useId();
  const open = active && (hovered || focused || pinned);
  // Auto-hide uses a full-size edge rail, including while it is offscreen.
  const expanded = open || (active && autoHide);
  const tucked = active && autoHide && !open;
  const HideIcon = edge === "left" ? ChevronLeft : edge === "right" ? ChevronRight : ChevronDown;
  const Icon = edge === "left" ? PanelLeft : edge === "right" ? PanelRight : PanelBottom;
  const label = `${edge.charAt(0).toUpperCase()}${edge.slice(1)} tools`;
  useEffect(() => { if (!active) { setHovered(false); setFocused(false); } }, [active]);
  return <div className={`focus-dock focus-dock-${edge}${active ? " enabled" : ""}${expanded ? " open" : ""}${active && autoHide ? " auto-hide" : ""}${tucked ? " tucked" : ""}`} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} onKeyDown={(event) => {
    if (active && open && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      setHovered(false); setFocused(false); if (pinned) changeMode("bubble");
      event.currentTarget.querySelector<HTMLButtonElement>(".focus-dock-handle")?.focus();
      setFocused(false);
    }
  }}>
    {active && <button type="button" className="focus-dock-handle" aria-label={label} aria-expanded={open} aria-pressed={pinned} aria-controls={id} title={`${label} · click to keep open`} onClick={() => { changeMode(pinned ? "bubble" : "pinned"); setFocused(false); setHovered(false); }}><Icon size={16} aria-hidden="true" /><span className="focus-dock-grip" aria-hidden="true" /></button>}
    <div id={id} className="focus-dock-content" ref={(node) => { if (node) node.inert = active && !open; }}><div className="focus-dock-inner">{children}{active && <div className="focus-dock-end"><span className="focus-dock-separator" aria-hidden="true" /><button type="button" className="focus-dock-hide" aria-label={`Hide ${edge} tools bubble`} title="Tuck against the edge · hover to reveal" onClick={(event) => {
      changeMode("auto-hide"); setHovered(false);
      event.currentTarget.closest(".focus-dock")?.querySelector<HTMLButtonElement>(".focus-dock-handle")?.focus();
      setFocused(false);
    }}><HideIcon size={15} aria-hidden="true" /></button></div>}</div></div>
  </div>;
}
