export type Panel = { id: string; type: "explorer" | "editor" };
export type EditorTab = {
  id: string;
  type: "file";
  title: string;
  path: string;
  dirty: boolean;
  content: string;
  savedContent: string;
  loading: boolean;
  error?: string;
};
export type EditorGroup = { id: string; tabs: EditorTab[]; activeTabId?: string };
export type LayoutModel = { panels: Panel[]; editorGroups: EditorGroup[] };

export const initialLayout: LayoutModel = {
  panels: [{ id: "explorer", type: "explorer" }, { id: "main-editor", type: "editor" }],
  editorGroups: [{ id: "primary", tabs: [] }]
};
