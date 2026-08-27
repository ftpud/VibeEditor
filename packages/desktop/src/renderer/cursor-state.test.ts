import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorTab } from "./model";
import { CursorPositionStore, validateCursorPosition } from "./cursor-state";

const tab = (id: string, path: string): EditorTab => ({ id, type: "file", title: path, path, dirty: false, content: "", savedContent: "", loading: false });

afterEach(() => vi.useRealTimers());

describe("CursorPositionStore", () => {
  it("keeps an independent cursor for each tab when switching between them", () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const store = new CursorPositionStore({ read: (workspace) => values.get(workspace) ?? null, write: (workspace, value) => values.set(workspace, value) });
    const first = tab("temporary-a", "src/a.ts");
    const second = tab("temporary-b", "src/b.ts");

    store.setWorkspace("/workspace");
    store.update(first, { lineNumber: 8, column: 4 });
    store.update(second, { lineNumber: 21, column: 2 });

    expect(store.get(first)).toEqual({ lineNumber: 8, column: 4 });
    expect(store.get(second)).toEqual({ lineNumber: 21, column: 2 });
    expect(values.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(values.size).toBe(1);
  });

  it("restores a file after reopen using document identity instead of tab ID", () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const persistence = { read: (workspace: string) => values.get(workspace) ?? null, write: (workspace: string, value: string) => values.set(workspace, value) };
    const beforeRestart = new CursorPositionStore(persistence);
    beforeRestart.setWorkspace("/workspace");
    beforeRestart.update(tab("old-random-id", "src/reopen.ts"), { lineNumber: 34, column: 7 });
    vi.advanceTimersByTime(500);

    const afterRestart = new CursorPositionStore(persistence);
    afterRestart.setWorkspace("/workspace");
    expect(afterRestart.get(tab("new-random-id", "src/reopen.ts"))).toEqual({ lineNumber: 34, column: 7 });
    expect(afterRestart.get(tab("another-id", "src/other.ts"))).toBeUndefined();
  });
});

describe("validateCursorPosition", () => {
  const model = { getLineCount: () => 3, getLineMaxColumn: (line: number) => [0, 6, 10, 2][line]! };

  it("clamps a stale saved cursor to the current document bounds", () => {
    expect(validateCursorPosition({ lineNumber: 20, column: 50 }, model)).toEqual({ lineNumber: 3, column: 2 });
  });

  it("rejects malformed positions", () => {
    expect(validateCursorPosition({ lineNumber: 0, column: 1 }, model)).toBeUndefined();
    expect(validateCursorPosition({ lineNumber: 1.5, column: 2 }, model)).toBeUndefined();
  });
});
