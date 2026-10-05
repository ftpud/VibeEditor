import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

const installed = new WeakSet<object>();

/** Inline token backgrounds cover Monaco's selection layer, so paint selections on the text too. */
export function highlightEditorSelection(codeEditor: editor.ICodeEditor): void {
  const decorations = codeEditor.createDecorationsCollection();
  const update = () => decorations.set((codeEditor.getSelections() ?? []).filter((selection) => !selection.isEmpty()).map((selection) => ({
    range: selection,
    options: { inlineClassName: "vibe-code-selection", stickiness: 1 }
  })));
  const listener = codeEditor.onDidChangeCursorSelection(update);
  const disposal = codeEditor.onDidDispose(() => { listener.dispose(); decorations.clear(); disposal.dispose(); });
  update();
}

export function installSelectionHighlight(monaco: Monaco): void {
  if (installed.has(monaco.editor)) return;
  installed.add(monaco.editor);
  monaco.editor.onDidCreateEditor(highlightEditorSelection);
}
