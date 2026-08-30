import { describe, expect, it, vi } from "vitest";
import { EditorViewStateStore } from "./editor-view-state";

describe("EditorViewStateStore", () => {
  it("restores each tab's complete Monaco view state after rapid switches", () => {
    const store = new EditorViewStateStore();
    const a = { saveViewState: vi.fn(() => ({ cursor: 7, scrollTop: 240 })), restoreViewState: vi.fn() };
    const b = { saveViewState: vi.fn(() => ({ cursor: 2, scrollTop: 40 })), restoreViewState: vi.fn() };
    store.mount("a", a); store.capture(a); store.mount("b", b); store.capture(b); store.mount("a", a); store.mount("b", b);
    expect(a.restoreViewState).toHaveBeenCalledWith({ cursor: 7, scrollTop: 240 });
    expect(b.restoreViewState).toHaveBeenCalledWith({ cursor: 2, scrollTop: 40 });
  });

  it("does not assign a stale editor state after a non-editor tab mounts", () => {
    const store = new EditorViewStateStore(); const editor = { saveViewState: vi.fn(() => ({ cursor: 4 })), restoreViewState: vi.fn() };
    store.mount("file", editor); store.clearMounted(); store.capture(editor); store.mount("other", editor);
    expect(editor.restoreViewState).not.toHaveBeenCalled();
  });
});
