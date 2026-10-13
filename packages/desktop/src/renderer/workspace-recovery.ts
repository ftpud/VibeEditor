import type { CoreClient } from "./client";
import type { EditorGroup, EditorTab } from "./model";

/** Check again at commit time: the UI may have changed while reads were pending. */
export function workspaceRestorationGuard(client: CoreClient, rootId: string, workspace: string, currentClient: () => CoreClient | undefined, currentWorkspace: () => string, signal?: AbortSignal): () => boolean {
  return () => !signal?.aborted && currentClient() === client && client.getRoot() === rootId && currentWorkspace() === workspace;
}

/** Retain current buffers, IDs, view settings, group ownership, and active selection. */
export function recoverEditorGroups(groups: EditorGroup[], restored: EditorTab[], restoredActiveId: string | undefined, rootId: string, current: () => boolean = () => true): EditorGroup[] {
  if (!current()) return groups;
  const key = (tab: EditorTab) => `${tab.rootId ?? rootId}\0${tab.type}\0${tab.path}`;
  const snapshots = new Map(restored.map((tab) => [key(tab), tab]));
  const liveKeys = new Set(groups.flatMap((group) => group.tabs.map(key)));
  const additions = restored.filter((tab) => !liveKeys.has(key(tab)));
  return groups.map((group, index) => {
    const tabs = group.tabs.map((tab) => {
      if (tab.dirty || (tab.rootId && tab.rootId !== rootId)) return tab;
      const snapshot = snapshots.get(key(tab));
      return snapshot ? { ...snapshot, id: tab.id, pinned: tab.pinned, markdownMode: tab.markdownMode } : tab;
    });
    if (index === 0) tabs.push(...additions);
    const activeTabId = tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId
      : tabs.find((tab) => tab.id === restoredActiveId)?.id ?? tabs[0]?.id;
    return { ...group, tabs, activeTabId };
  });
}
