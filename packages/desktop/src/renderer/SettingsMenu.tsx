import { FontPicker } from "./FontPicker";
import { SegmentedControl } from "./SegmentedControl";
import { Moon, RotateCcw, Sun, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Command, CommandId, DesktopPlatform, ShortcutBindings } from "./command-registry";
import { ShortcutSettings } from "./ShortcutSettings";

export type DesktopSettings = {
  theme: "dark" | "light";
  highlightTheme: "default" | "ftpud";
  uiFontFamily: "jetbrains" | "inter";
  uiFontWeight: number;
  uiFontSize: number;
  uiLineHeight: number;
};

type Props = {
  onClose?(): void;
  onStorage?: () => void;
  onAiProviders?: () => void;
  onTools?: () => void;
  workspace: string;
  sideLayout: "classic" | "ai-focused";
  values: DesktopSettings;
  isWorkspaceOverride: (setting: keyof DesktopSettings) => boolean;
  onChange: <K extends keyof DesktopSettings>(setting: K, value: DesktopSettings[K]) => void;
  onReset: (setting: keyof DesktopSettings) => void;
  onSideLayoutChange: (layout: "classic" | "ai-focused") => void;
  commands: Command[]; shortcutBindings: ShortcutBindings; platform: DesktopPlatform;
  onShortcutChange: (id: CommandId, shortcut?: string) => void; onShortcutsReset: () => void;
};

const labels: Record<keyof DesktopSettings, string> = { theme: "Theme", highlightTheme: "Highlighting", uiFontFamily: "Font", uiFontWeight: "Font weight", uiFontSize: "Size", uiLineHeight: "Line height" };

export function SettingsMenu({ onClose, onStorage, onAiProviders, onTools, workspace, sideLayout, values, isWorkspaceOverride, onChange, onReset, onSideLayoutChange, commands, shortcutBindings, platform, onShortcutChange, onShortcutsReset }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest("[data-settings-popover]")) return; if (!root.current?.parentElement?.contains(event.target as Node)) closeRef.current?.(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { closeRef.current?.(); root.current?.parentElement?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  const [query, setQuery] = useState("");
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const visible = useMemo(() => (Object.keys(labels) as (keyof DesktopSettings)[]).filter((setting) => matches(labels[setting])), [query]);
  const row = <K extends keyof DesktopSettings>(setting: K, control: ReactNode) => !visible.includes(setting) ? null : <div className="settings-row settings-choice" data-setting={setting} key={setting}><div><label>{labels[setting]}</label><small>{workspace ? (isWorkspaceOverride(setting) ? "Workspace override" : "Global default") : "Global default"}</small></div><div className="settings-control">{control}{workspace && isWorkspaceOverride(setting) && <button className="settings-reset icon-button" aria-label={`Reset ${labels[setting]} to global default`} title={`Reset ${labels[setting]} to global default`} onClick={() => onReset(setting)}><RotateCcw size={14} /></button>}</div></div>;
  return <div ref={root} className="settings-menu" role="dialog" aria-label="Desktop settings">
    <header><strong>Settings</strong>{onClose && <button className="icon-button" aria-label="Close settings" onClick={onClose}><X size={16} /></button>}</header>
    <input className="settings-search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
    {onAiProviders && matches("AI providers") && <div className="settings-row settings-choice"><div><label>AI providers</label><small>Install, update or delete Codex, Claude and Copilot, and check sign-in</small></div><button onClick={onAiProviders}>AI providers…</button></div>}
    {onTools && (matches("Tools") || matches("Java language server")) && <div className="settings-row settings-choice"><div><label>Tools</label><small>Download the Java runtime and Java language server for highlighting</small></div><button onClick={onTools}>Tools…</button></div>}
    {onStorage && matches("Storage cleanup") && <div className="settings-row settings-choice"><div><label>Server storage</label><small>Review disk usage and remove stored data</small></div><button onClick={onStorage}>Storage…</button></div>}
    {matches("Layout") && <div className="settings-row settings-choice"><div><label>Layout</label><small>Global default</small></div><SegmentedControl label="Layout" value={sideLayout} options={[{ value: "classic", label: "Classic" }, { value: "ai-focused", label: "AI focused" }]} onChange={onSideLayoutChange} /></div>}
    {row("theme", <SegmentedControl label="Theme" value={values.theme} options={[{ value: "dark", label: "Dark", icon: <Moon size={13} /> }, { value: "light", label: "Light", icon: <Sun size={13} /> }]} onChange={(value) => onChange("theme", value)} />)}
    {row("highlightTheme", <SegmentedControl label="Highlighting" value={values.highlightTheme} options={[{ value: "default", label: "Default" }, { value: "ftpud", label: "Ftpud" }]} onChange={(value) => onChange("highlightTheme", value)} />)}
    {row("uiFontFamily", <FontPicker value={values.uiFontFamily} onChange={(value) => onChange("uiFontFamily", value)} />)}
    {row("uiFontWeight", <input aria-label="Font weight" type="number" min="350" max="600" step="50" value={values.uiFontWeight} onChange={(event) => onChange("uiFontWeight", Math.min(600, Math.max(350, Number(event.target.value) || 450)))} />)}
    {row("uiFontSize", <input aria-label="Size" type="number" min="10" max="20" step="1" value={values.uiFontSize} onChange={(event) => onChange("uiFontSize", Math.min(20, Math.max(10, Number(event.target.value) || 13)))} />)}
    {row("uiLineHeight", <input aria-label="Line height" type="number" min="1" max="2" step="0.05" value={values.uiLineHeight} onChange={(event) => onChange("uiLineHeight", Math.min(2, Math.max(1, Number(event.target.value) || 1.2)))} />)}
    {matches("Keyboard shortcuts") && <ShortcutSettings commands={commands} bindings={shortcutBindings} platform={platform} onChange={onShortcutChange} onReset={onShortcutsReset} />}
    {visible.length === 0 && !matches("Layout") && !matches("Keyboard shortcuts") && !(onStorage && matches("Storage cleanup")) && !(onAiProviders && matches("AI providers")) && !(onTools && (matches("Tools") || matches("Java language server"))) && <p className="settings-empty">No desktop settings match “{query}”.</p>}
  </div>;
}
