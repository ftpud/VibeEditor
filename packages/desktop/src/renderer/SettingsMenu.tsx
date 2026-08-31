import { useMemo, useState, type ReactNode } from "react";
import type { Command, CommandId, DesktopPlatform, ShortcutBindings } from "./command-registry";
import { ShortcutSettings } from "./ShortcutSettings";

export type DesktopSettings = {
  theme: "dark" | "light";
  highlightTheme: "default" | "ftpud";
  uiFontFamily: "jetbrains" | "inter";
  uiFontSize: number;
  uiLineHeight: number;
};

type Props = {
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

const labels: Record<keyof DesktopSettings, string> = { theme: "Theme", highlightTheme: "Highlighting", uiFontFamily: "Font", uiFontSize: "Size", uiLineHeight: "Line height" };

export function SettingsMenu({ workspace, sideLayout, values, isWorkspaceOverride, onChange, onReset, onSideLayoutChange, commands, shortcutBindings, platform, onShortcutChange, onShortcutsReset }: Props) {
  const [query, setQuery] = useState("");
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const visible = useMemo(() => (Object.keys(labels) as (keyof DesktopSettings)[]).filter((setting) => matches(labels[setting])), [query]);
  const row = <K extends keyof DesktopSettings>(setting: K, control: ReactNode) => !visible.includes(setting) ? null : <div className="settings-row settings-choice" data-setting={setting} key={setting}><div><label>{labels[setting]}</label><small>{workspace ? (isWorkspaceOverride(setting) ? "Workspace override" : "Global default") : "Global default"}</small></div><div className="settings-control">{control}{workspace && isWorkspaceOverride(setting) && <button className="settings-reset" title={`Use global default for ${labels[setting]}`} onClick={() => onReset(setting)}>Reset</button>}</div></div>;
  return <div className="settings-menu" role="dialog" aria-label="Desktop settings">
    <header>Settings</header>
    <input className="settings-search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
    {matches("Layout") && <div className="settings-row settings-choice"><div><label>Layout</label><small>Global default</small></div><div className="theme-switch"><button className={sideLayout === "classic" ? "active" : ""} onClick={() => onSideLayoutChange("classic")}>Classic</button><button className={sideLayout === "ai-focused" ? "active" : ""} onClick={() => onSideLayoutChange("ai-focused")}>AI focused</button></div></div>}
    {row("theme", <div className="theme-switch"><button className={values.theme === "dark" ? "active" : ""} onClick={() => onChange("theme", "dark")}>Dark</button><button className={values.theme === "light" ? "active" : ""} onClick={() => onChange("theme", "light")}>Light</button></div>)}
    {row("highlightTheme", <div className="theme-switch"><button className={values.highlightTheme === "default" ? "active" : ""} onClick={() => onChange("highlightTheme", "default")}>Default</button><button className={values.highlightTheme === "ftpud" ? "active" : ""} onClick={() => onChange("highlightTheme", "ftpud")}>Ftpud</button></div>)}
    {row("uiFontFamily", <select aria-label="Font" value={values.uiFontFamily} onChange={(event) => onChange("uiFontFamily", event.target.value as DesktopSettings["uiFontFamily"])}><option value="jetbrains">JetBrains Mono</option><option value="inter">Inter</option></select>)}
    {row("uiFontSize", <input aria-label="Size" type="number" min="10" max="20" step="1" value={values.uiFontSize} onChange={(event) => onChange("uiFontSize", Math.min(20, Math.max(10, Number(event.target.value) || 13)))} />)}
    {row("uiLineHeight", <input aria-label="Line height" type="number" min="1" max="2" step="0.05" value={values.uiLineHeight} onChange={(event) => onChange("uiLineHeight", Math.min(2, Math.max(1, Number(event.target.value) || 1.2)))} />)}
    {matches("Keyboard shortcuts") && <ShortcutSettings commands={commands} bindings={shortcutBindings} platform={platform} onChange={onShortcutChange} onReset={onShortcutsReset} />}
    {visible.length === 0 && !matches("Layout") && !matches("Keyboard shortcuts") && <p className="settings-empty">No desktop settings match “{query}”.</p>}
  </div>;
}
