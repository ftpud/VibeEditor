import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { editor } from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStatusBar, formatIndentation, formatLanguage, sameEditorStatus, type EditorStatusBarHandle } from "./EditorStatusBar";

afterEach(cleanup);

describe("editor status formatting", () => {
  it("formats language and indentation labels", () => {
    expect(formatLanguage("typescript")).toBe("TypeScript"); expect(formatLanguage("sap-cds")).toBe("Sap Cds");
    expect(formatIndentation(true, 2)).toBe("Spaces: 2"); expect(formatIndentation(false, 4)).toBe("Tab Size: 4");
  });
  it("recognizes unchanged snapshots", () => {
    const status = { line: 3, column: 7, selectedCharacters: 0, language: "TypeScript", indentation: "Spaces: 2" };
    expect(sameEditorStatus(status, { ...status })).toBe(true); expect(sameEditorStatus(status, { ...status, column: 8 })).toBe(false);
  });
});

function fakeEditor() {
  let position = { lineNumber: 2, column: 5 }; let selection = { isEmpty: () => true }; const listeners: (() => void)[] = [];
  const subscribe = (listener: () => void) => { listeners.push(listener); return { dispose: vi.fn() }; };
  const instance = { getModel: () => ({ getOptions: () => ({ insertSpaces: true, tabSize: 2 }), getLanguageId: () => "typescript", getValueLengthInRange: () => 12 }), getPosition: () => position, getSelection: () => selection, onDidChangeCursorPosition: subscribe, onDidChangeCursorSelection: subscribe, onDidChangeModel: subscribe, onDidChangeModelLanguage: subscribe, onDidChangeConfiguration: subscribe, onDidChangeModelContent: subscribe, trigger: vi.fn() };
  return { instance: instance as unknown as editor.IStandaloneCodeEditor, select: () => { position = { lineNumber: 4, column: 9 }; selection = { isEmpty: () => false }; listeners.forEach((listener) => listener()); } };
}

describe("EditorStatusBar", () => {
  it("updates from editor events and invokes Go to Line", () => {
    const ref = createRef<EditorStatusBarHandle>(); const fake = fakeEditor(); render(<EditorStatusBar ref={ref} active />); act(() => ref.current?.attach(fake.instance));
    expect(screen.getByRole("button").textContent).toBe("Ln 2, Col 5"); expect(screen.queryByText(/selected/)).toBeNull();
    act(() => fake.select()); expect(screen.getByText("12 selected")).toBeTruthy(); fireEvent.click(screen.getByRole("button"));
    expect(fake.instance.trigger).toHaveBeenCalledWith("editor-status-bar", "editor.action.gotoLine", null);
  });
  it("renders nothing without an active editor", () => { render(<EditorStatusBar active={false} />); expect(screen.queryByLabelText("Editor status")).toBeNull(); });
});
