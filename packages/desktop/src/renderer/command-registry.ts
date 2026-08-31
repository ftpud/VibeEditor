/** A provider-neutral Desktop command contract. Commands carry their own availability
 * rather than relying on UI event names or button text. */
export type CommandCategory = "Project" | "Git" | "Terminal" | "Task" | "AI" | "Editor";
export const commandIds = ["project.commandPalette", "project.quickOpen", "project.workspaceSymbols", "project.refresh", "project.findInFiles", "editor.navigateBack", "editor.navigateForward", "editor.save", "git.refresh", "terminal.new", "terminal.toggle", "task.create", "ai.open"] as const;
export type CommandId = typeof commandIds[number];
export type DesktopPlatform = "mac" | "windows" | "linux";
export type ShortcutBindings = Partial<Record<CommandId, string>>;

export type CommandContext = { connected: boolean; hasActiveEditor: boolean; activeEditorDirty: boolean; gitBusy: boolean; taskSwitching: boolean; aiBusy: boolean };

export type Command = {
  id: CommandId;
  label: string;
  category: CommandCategory;
  when?(context: CommandContext): boolean;
  execute(): void | Promise<void>;
};

const defaults: Record<DesktopPlatform, ShortcutBindings> = {
  mac: { "project.commandPalette": "Meta+Shift+P", "project.quickOpen": "Meta+P", "project.workspaceSymbols": "Meta+T", "editor.navigateBack": "Alt+ArrowLeft", "editor.navigateForward": "Alt+ArrowRight", "editor.save": "Meta+S" },
  windows: { "project.commandPalette": "Ctrl+Shift+P", "project.quickOpen": "Ctrl+P", "project.workspaceSymbols": "Ctrl+T", "editor.navigateBack": "Alt+ArrowLeft", "editor.navigateForward": "Alt+ArrowRight", "editor.save": "Ctrl+S" },
  linux: { "project.commandPalette": "Ctrl+Shift+P", "project.quickOpen": "Ctrl+P", "project.workspaceSymbols": "Ctrl+T", "editor.navigateBack": "Alt+ArrowLeft", "editor.navigateForward": "Alt+ArrowRight", "editor.save": "Ctrl+S" }
};
const reserved: Record<DesktopPlatform, Record<string, string>> = {
  mac: { "Meta+Q": "Electron: Quit", "Meta+W": "Monaco/editor: Close tab", "Ctrl+Tab": "Monaco/editor: Next tab", "Ctrl+Shift+Tab": "Monaco/editor: Previous tab", "Meta+F": "Monaco: Find", "Meta+G": "Monaco: Find next" },
  windows: { "Alt+F4": "Electron: Close window", "Ctrl+W": "Monaco/editor: Close tab", "Ctrl+Tab": "Monaco/editor: Next tab", "Ctrl+Shift+Tab": "Monaco/editor: Previous tab", "Ctrl+F": "Monaco: Find", "Ctrl+G": "Monaco: Go to line" },
  linux: { "Alt+F4": "Electron: Close window", "Ctrl+W": "Monaco/editor: Close tab", "Ctrl+Tab": "Monaco/editor: Next tab", "Ctrl+Shift+Tab": "Monaco/editor: Previous tab", "Ctrl+F": "Monaco: Find", "Ctrl+G": "Monaco: Go to line" }
};

export function desktopPlatform(): DesktopPlatform {
  const value = (typeof document !== "undefined" ? document.documentElement.dataset.platform : "") || (typeof navigator !== "undefined" ? navigator.platform : "");
  return value.toLowerCase().includes("mac") ? "mac" : value.toLowerCase().includes("win") ? "windows" : "linux";
}
export function defaultShortcutBindings(platform: DesktopPlatform): ShortcutBindings { return { ...defaults[platform] }; }
export function normalizeShortcut(value: string): string | undefined {
  const aliases: Record<string, string> = { control: "Ctrl", ctrl: "Ctrl", meta: "Meta", cmd: "Meta", command: "Meta", alt: "Alt", option: "Alt", shift: "Shift", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", esc: "Escape", space: "Space" };
  const modifiers = new Set<string>(); let key = "";
  for (const raw of value.split("+")) { const part = aliases[raw.trim().toLowerCase()] ?? (raw.trim().length === 1 ? raw.trim().toUpperCase() : raw.trim()); if (["Ctrl", "Meta", "Alt", "Shift"].includes(part)) modifiers.add(part); else if (part) { if (key) return undefined; key = part; } }
  if (!key || (!modifiers.size && key.length === 1)) return undefined;
  return [...["Ctrl", "Meta", "Alt", "Shift"].filter((part) => modifiers.has(part)), key].join("+");
}
export function shortcutFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | undefined {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return undefined;
  const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return normalizeShortcut(`${event.ctrlKey ? "Ctrl+" : ""}${event.metaKey ? "Meta+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${key}`);
}
export function shortcutMatches(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, shortcut?: string): boolean { return Boolean(shortcut && shortcutFromEvent(event) === shortcut); }
export function shortcutConflict(commandId: CommandId, shortcut: string, bindings: ShortcutBindings, platform: DesktopPlatform): string | undefined {
  const normalized = normalizeShortcut(shortcut); if (!normalized) return "Enter a shortcut with a modifier key.";
  const reservedBy = reserved[platform][normalized]; if (reservedBy) return `Reserved by ${reservedBy}.`;
  const duplicate = commandIds.find((id) => id !== commandId && bindings[id] === normalized); return duplicate ? `Already assigned to ${duplicate}.` : undefined;
}
export function formatShortcut(shortcut: string, platform: DesktopPlatform): string { return platform === "mac" ? shortcut.replace("Meta", "Cmd").replace("Alt", "Option") : shortcut; }

export function commandEnabled(command: Command, context: CommandContext): boolean {
  return command.when?.(context) ?? true;
}

export function rankCommands(commands: Command[], query: string): Command[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => terms.every((term) => `${command.label} ${command.category} ${command.id}`.toLocaleLowerCase().includes(term)));
}
