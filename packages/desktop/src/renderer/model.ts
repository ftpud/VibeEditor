export type Panel = { id: string; type: "explorer" | "editor" | "terminal" | "java" | "problems" | "gitlog" };
export type EditorTab = {
  id: string;
  type: "file" | "diff" | "useful" | "agent" | "runConfig";
  title: string;
  path: string;
  /** Stable owner for every workspace-relative path held by this tab. */
  rootId?: string;
  dirty: boolean;
  content: string;
  savedContent: string;
  revision?: { identity: string; version: string };
  loading: boolean;
  pinned?: boolean;
  error?: string;
  originalContent?: string;
  diffMode?: "split" | "unified";
  diffRef?: string;
  diffPath?: string;
  diffOriginalPath?: string;
  markdownMode?: "edit" | "preview";
  usefulScope?: "global" | "local";
  agentScope?: "global" | "local";
  runConfigScope?: "global" | "local";
};
export type EditorGroup = { id: string; tabs: EditorTab[]; activeTabId?: string };

/** File tabs are named from their path so a malformed tree label cannot replace the filename. */
export function editorTabLabel(tab: EditorTab): string {
  return tab.type === "file" ? (tab.path.split("/").pop() ?? tab.title) : tab.title;
}
/** Renderer-only recovery state. A recreated tab is a new Core-owned shell, never a restored process. */
export type TerminalRecovery = "reattached" | "recreated";
export type TerminalTab = { id: string; terminalId: string; rootId?: string; title: string; status: "running" | "exited" | "unavailable"; exitCode?: number; recovery?: TerminalRecovery };
export type TerminalGroup = { id: string; tabs: TerminalTab[]; activeTabId?: string };
export type LayoutModel = { panels: Panel[]; editorGroups: EditorGroup[]; terminalGroup: TerminalGroup };

export const initialLayout: LayoutModel = {
  panels: [{ id: "explorer", type: "explorer" }, { id: "main-editor", type: "editor" }],
  editorGroups: [{ id: "primary", tabs: [] }],
  terminalGroup: { id: "terminal-primary", tabs: [] }
};

/** Replaces one root's restored state without discarding tabs owned by other roots. */
export function mergeRootOwnedTabs<T extends { rootId?: string }>(existing: T[], restored: T[], rootId: string, identity: (item: T) => string): T[] {
  const retained = existing.filter((item) => item.rootId);
  const known = new Set(retained.filter((item) => item.rootId === rootId).map(identity));
  return [...retained, ...restored.filter((item) => !known.has(identity(item)))];
}
