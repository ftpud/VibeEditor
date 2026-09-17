import {
  commandIds,
  defaultShortcutBindings,
  normalizeShortcut,
  type CommandId,
  type DesktopPlatform,
  type ShortcutBindings,
} from "./command-registry";
export const KEYBOARD_SHORTCUTS_SETTING = "keyboardShortcuts";
export function parseShortcutSetting(
  value: string | null,
  platform: DesktopPlatform,
): ShortcutBindings {
  const result = defaultShortcutBindings(platform);
  if (!value) return result;
  try {
    const parsed: unknown = JSON.parse(value);
    const versioned = typeof parsed === "object" && parsed !== null && "version" in parsed;
    const candidate =
      versioned
        ? (parsed as { version?: unknown; bindings?: unknown }).version === 1
          ? (parsed as { bindings?: unknown }).bindings
          : undefined
        : parsed;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return result;
    for (const id of commandIds) {
      const stored = (candidate as Record<string, unknown>)[id];
      if (stored === null) delete result[id];
      else if (typeof stored === "string") {
        const normalized = normalizeShortcut(stored);
        if (normalized) result[id] = normalized;
      }
    }
    if (versioned && Array.isArray((parsed as { disabled?: unknown }).disabled)) {
      for (const id of (parsed as unknown as { disabled: unknown[] }).disabled) if (commandIds.includes(id as CommandId)) delete result[id as CommandId];
    }
  } catch {
    /* Damaged settings retain safe defaults. */
  }
  return result;
}
export function serializeShortcutSetting(bindings: ShortcutBindings): string {
  const safe: ShortcutBindings = {};
  for (const id of commandIds) if (bindings[id]) safe[id] = bindings[id];
  return JSON.stringify({ version: 1, bindings: safe, disabled: commandIds.filter((id) => !bindings[id]) });
}
/** Returns a validated v1 replacement only for the legacy unversioned command-id map. */
export function migrateShortcutSetting(value: string | null, platform: DesktopPlatform): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || "version" in parsed) return undefined;
    return serializeShortcutSetting(parseShortcutSetting(value, platform));
  } catch { return undefined; }
}
export function updateShortcut(
  bindings: ShortcutBindings,
  id: CommandId,
  shortcut?: string,
): ShortcutBindings {
  const next = { ...bindings };
  if (shortcut) next[id] = shortcut;
  else delete next[id];
  return next;
}
