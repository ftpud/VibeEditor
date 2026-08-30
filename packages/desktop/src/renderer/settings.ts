/**
 * Client side setting store for UI preferences such as panel visibility, panel sizes, and fonts.
 *
 * Values are mirrored into a JSON file owned by the Electron main process, because the packaged
 * renderer is served from a `file://` origin where browser storage is not guaranteed to survive a
 * restart. `localStorage` is still written so a browser-only renderer (dev server, detached window
 * without the preload bridge) keeps working, and existing stored values are migrated on first load.
 */
const bridge = typeof window === "undefined" ? undefined : window.desktop;

const cache = new Map<string, string>();

function browserRead(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function browserWrite(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable or full. */ }
}

let loaded = false;
function load(): void {
  if (loaded) return;
  loaded = true;
  let stored: Record<string, string> = {};
  try { stored = bridge?.loadSettings?.() ?? {}; } catch { stored = {}; }
  for (const [key, value] of Object.entries(stored)) if (typeof value === "string") cache.set(key, value);
  if (Object.keys(stored).length > 0) return;
  // First run after the durable store was introduced: adopt whatever the browser still remembers.
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key === null ? null : localStorage.getItem(key);
      if (key !== null && value !== null) { cache.set(key, value); bridge?.writeSetting?.(key, value); }
    }
  } catch { /* Storage may be unavailable. */ }
}

export function readSetting(key: string): string | null {
  load();
  const value = cache.get(key);
  return value ?? browserRead(key);
}

export function readSettingNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(readSetting(key));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function writeSetting(key: string, value: string): void {
  load();
  cache.set(key, value);
  browserWrite(key, value);
  try { bridge?.writeSetting?.(key, value); } catch { /* Main process bridge is optional. */ }
}

/** Removes a persisted setting, allowing callers to fall back to its default. */
export function removeSetting(key: string): void {
  load();
  cache.delete(key);
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  try { bridge?.writeSetting?.(key, null); } catch { /* Main process bridge is optional. */ }
}

/** Setting name scoped to a single remote workspace. */
export function workspaceSettingKey(workspace: string, setting: string): string {
  return `workspace:${encodeURIComponent(workspace)}:${setting}`;
}

/** Whether this workspace has a value instead of inheriting the global default. */
export function hasWorkspaceSetting(workspace: string, setting: string): boolean {
  return Boolean(workspace) && readSetting(workspaceSettingKey(workspace, setting)) !== null;
}

/** Restores a workspace setting to the global default. */
export function resetWorkspaceSetting(workspace: string, setting: string): void {
  if (workspace) removeSetting(workspaceSettingKey(workspace, setting));
}

/** Reads a workspace setting and falls back to the global value used across workspaces. */
export function readWorkspaceSetting(workspace: string, setting: string): string | null {
  return (workspace ? readSetting(workspaceSettingKey(workspace, setting)) : null) ?? readSetting(setting);
}

/** Writes a setting for the given workspace and keeps the global value in sync as the default. */
export function writeWorkspaceSetting(workspace: string, setting: string, value: string): void {
  writeSetting(setting, value);
  if (workspace) writeSetting(workspaceSettingKey(workspace, setting), value);
}
