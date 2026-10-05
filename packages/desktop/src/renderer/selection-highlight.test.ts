import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { expect, it, vi } from "vitest";
import { highlightEditorSelection, installSelectionHighlight } from "./selection-highlight";

it("registers once even when multiple editors configure their themes", () => {
  const onDidCreateEditor = vi.fn();
  const monaco = { editor: { onDidCreateEditor } } as unknown as Monaco;
  installSelectionHighlight(monaco);
  installSelectionHighlight(monaco);
  expect(onDidCreateEditor).toHaveBeenCalledTimes(1);
  expect(onDidCreateEditor).toHaveBeenCalledWith(highlightEditorSelection);
});

it("paints nonempty selections, clears collapsed selections, and releases listeners", () => {
  const selection = { startLineNumber: 1, startColumn: 3, endLineNumber: 2, endColumn: 5, isEmpty: () => false };
  let selections = [selection];
  let change!: () => void;
  let dispose!: () => void;
  const set = vi.fn();
  const clear = vi.fn();
  const listener = { dispose: vi.fn() };
  const disposal = { dispose: vi.fn() };
  const codeEditor = {
    createDecorationsCollection: () => ({ set, clear }),
    getSelections: () => selections,
    onDidChangeCursorSelection: (callback: () => void) => { change = callback; return listener; },
    onDidDispose: (callback: () => void) => { dispose = callback; return disposal; }
  } as unknown as editor.ICodeEditor;
  highlightEditorSelection(codeEditor);
  expect(set).toHaveBeenLastCalledWith([{ range: selection, options: expect.objectContaining({ inlineClassName: "vibe-code-selection" }) }]);
  selections = [selection, { ...selection, startLineNumber: 4, endLineNumber: 4 }];
  change();
  expect(set.mock.calls.at(-1)![0]).toHaveLength(2);
  selections = [{ ...selection, isEmpty: () => true }];
  change();
  expect(set).toHaveBeenLastCalledWith([]);
  dispose();
  expect(listener.dispose).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
});
