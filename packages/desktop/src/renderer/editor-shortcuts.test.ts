import { afterEach, describe, expect, it } from "vitest";
import { adjacentEditorTabId, editorShortcutEligible, editorTabShortcut } from "./editor-shortcuts";

afterEach(() => { document.body.innerHTML = ""; });

describe("adjacentEditorTabId", () => {
  const tabs = ["one", "two", "three"];

  it("moves forward and wraps around", () => {
    expect(adjacentEditorTabId(tabs, "one")).toBe("two");
    expect(adjacentEditorTabId(tabs, "three")).toBe("one");
  });

  it("moves backward and wraps around", () => {
    expect(adjacentEditorTabId(tabs, "three", true)).toBe("two");
    expect(adjacentEditorTabId(tabs, "one", true)).toBe("three");
  });

  it("returns no selection when there are no tabs", () => {
    expect(adjacentEditorTabId([], undefined)).toBeUndefined();
  });
});

describe("editor shortcuts", () => {
  it("recognizes navigation and platform close modifiers", () => {
    expect(editorTabShortcut({ key: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("next");
    expect(editorTabShortcut({ key: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("previous");
    expect(editorTabShortcut({ key: "w", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("close");
    expect(editorTabShortcut({ key: "w", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe("close");
  });

  it("excludes dialogs, context menus, terminals, focused controls, and Monaco suggestions", () => {
    for (const html of [
      '<div role="dialog"><button id="target">OK</button></div>',
      '<div class="context-menu-layer"><button id="target">Item</button></div>',
      '<div class="terminal-panel"><textarea id="target"></textarea></div>',
      '<input id="target">',
      '<div class="monaco-editor"><div class="suggest-widget visible"></div><textarea id="target"></textarea></div>'
    ]) {
      document.body.innerHTML = html;
      expect(editorShortcutEligible(document.querySelector("#target"), document)).toBe(false);
    }
  });

  it("allows the Monaco editor when no widget is claiming input", () => {
    document.body.innerHTML = '<div class="monaco-editor"><textarea id="target"></textarea></div>';
    expect(editorShortcutEligible(document.querySelector("#target"), document)).toBe(true);
  });
});
