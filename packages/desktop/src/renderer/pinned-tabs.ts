import type { EditorTab } from "./model";

/**
 * A stable partition keeps pinned tabs at the leading edge without disturbing
 * either section's existing order. Files still open normally: this deliberately
 * does not introduce preview-tab replacement.
 */
export function orderPinnedTabs(tabs: EditorTab[]): EditorTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

export function togglePinnedTab(tabs: EditorTab[], id: string): EditorTab[] {
  return orderPinnedTabs(tabs.map((tab) => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab));
}

export function pinnedFilePaths(tabs: EditorTab[]): string[] {
  return tabs.filter((tab) => tab.type === "file" && tab.pinned).map((tab) => tab.path);
}
