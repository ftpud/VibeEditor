export type EditorTabShortcut = "next" | "previous" | "close";

export function editorTabShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): EditorTabShortcut | undefined {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab") return event.shiftKey ? "previous" : "next";
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "w") return "close";
  return undefined;
}

export function adjacentEditorTabId(tabIds: readonly string[], activeTabId: string | undefined, reverse = false): string | undefined {
  if (tabIds.length === 0) return undefined;
  const activeIndex = activeTabId ? tabIds.indexOf(activeTabId) : -1;
  if (activeIndex < 0) return reverse ? tabIds.at(-1) : tabIds[0];
  return tabIds[(activeIndex + (reverse ? -1 : 1) + tabIds.length) % tabIds.length];
}

export function editorShortcutEligible(target: EventTarget | null, documentRoot: ParentNode): boolean {
  if (documentRoot.querySelector('[role="dialog"], [role="alertdialog"], .context-menu-layer, .floating-window-layer, .monaco-editor .suggest-widget.visible')) return false;
  if (!(target instanceof Element)) return true;
  if (target.closest(".terminal-panel")) return false;
  if (target.closest(".monaco-editor")) return true;
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"]');
}
