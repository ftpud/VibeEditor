import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useCallback, useState } from "react";
import { readSetting, writeSetting } from "./settings";

type Edge = "left" | "right";

/** Client-wide layout preferences use the same durable store as sidebar sizes. */
export function useSidebarExtent(edge: Edge): [boolean, (extended: boolean) => void] {
  const key = `sidebar.${edge}Extended`;
  const [extended, setExtended] = useState(() => readSetting(key) === "true");
  const change = useCallback((next: boolean) => {
    writeSetting(key, String(next));
    setExtended(next);
  }, [key]);
  return [extended, change];
}

export function SidebarExtentButton({ edge, extended, onChange }: { edge: Edge; extended: boolean; onChange(extended: boolean): void }) {
  const label = extended ? `Restore ${edge} sidebar height` : `Extend ${edge} sidebar to bottom`;
  const Icon = extended ? ArrowUpFromLine : ArrowDownToLine;
  return <button type="button" className={`tool-stripe-button sidebar-extent-button${edge === "right" ? " right" : ""}${extended ? " active" : ""}`} aria-label={label} title={label} aria-pressed={extended} onClick={() => onChange(!extended)}><Icon size={15} aria-hidden="true" /></button>;
}
