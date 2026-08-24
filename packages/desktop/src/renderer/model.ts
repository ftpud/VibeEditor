export type Panel = { id: string; type: "explorer" | "editor" | "terminal" | "java" };
export type EditorTab = {
  id: string;
  type: "file" | "diff";
  title: string;
  path: string;
  dirty: boolean;
  content: string;
  savedContent: string;
  loading: boolean;
  error?: string;
  originalContent?: string;
  diffMode?: "split" | "unified";
  markdownMode?: "edit" | "preview";
};
export type EditorGroup = { id: string; tabs: EditorTab[]; activeTabId?: string };
export type TerminalTab = { id: string; terminalId: string; title: string; exited: boolean };
export type TerminalGroup = { id: string; tabs: TerminalTab[]; activeTabId?: string };
export type LayoutModel = { panels: Panel[]; editorGroups: EditorGroup[]; terminalGroup: TerminalGroup };

export const initialLayout: LayoutModel = {
  panels: [{ id: "explorer", type: "explorer" }, { id: "main-editor", type: "editor" }],
  editorGroups: [{ id: "primary", tabs: [] }],
  terminalGroup: { id: "terminal-primary", tabs: [] }
};
