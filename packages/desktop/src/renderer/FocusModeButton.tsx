import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect } from "react";

export function FocusModeButton({ active, onChange }: { active: boolean; onChange(active: boolean): void }) {
  useEffect(() => {
    if (!active) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], .context-menu-layer, .floating-window-layer, .monaco-editor .suggest-widget.visible')) return;
      event.preventDefault();
      onChange(false);
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [active, onChange]);
  return <button className="workspace-settings-button workspace-focus-button" aria-label={active ? "Exit focus mode" : "Enter focus mode"} title={active ? "Restore workspace spacing and tool bars · Escape" : "Focus workspace · dock tools at the edges"} aria-pressed={active} onClick={() => onChange(!active)}>
    {active ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
  </button>;
}
