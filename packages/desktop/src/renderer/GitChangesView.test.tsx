import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatusEntry } from "@remote-ide/protocol";
import { GitChangesView } from "./GitChangesView";

afterEach(cleanup);
const entries: GitStatusEntry[] = [{ path: "src/first.ts", indexStatus: " ", worktreeStatus: "M", states: ["worktree"] }, { path: "src/second.ts", indexStatus: " ", worktreeStatus: "M", states: ["worktree"] }];

describe("GitChangesView keyboard and selection states", () => {
  it("reviews the focused row with Enter and moves focus with arrows", () => {
    const onOpenDiff = vi.fn(); render(<GitChangesView entries={entries} error="" onOpenDiff={onOpenDiff} onOpenFile={vi.fn()} />);
    const first = screen.getByRole("button", { name: /first\.ts/ }); const second = screen.getByRole("button", { name: /second\.ts/ }); first.focus(); fireEvent.keyDown(first, { key: "ArrowDown" }); expect(document.activeElement).toBe(second); fireEvent.keyDown(second, { key: "Enter" }); expect(onOpenDiff).toHaveBeenCalledWith(entries[1]);
  });
  it("keeps checked-for-commit distinct from the active diff and toggles it with Space", () => {
    const onTogglePath = vi.fn(); render(<GitChangesView entries={entries} error="" selectedPaths={new Set(["src/first.ts"])} activePath="src/second.ts" onTogglePath={onTogglePath} onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    const first = screen.getByRole("button", { name: /first\.ts/ }); const second = screen.getByRole("button", { name: /second\.ts/ }); expect(first.classList.contains("checked-for-commit")).toBe(true); expect(first.classList.contains("active-diff")).toBe(false); expect(second.classList.contains("active-diff")).toBe(true); first.focus(); fireEvent.keyDown(first, { key: " " }); expect(onTogglePath).toHaveBeenCalledWith("src/first.ts");
  });
  it("opens a non-deleted file with Shift+Enter", () => {
    const onOpenFile = vi.fn(); render(<GitChangesView entries={entries} error="" onOpenDiff={vi.fn()} onOpenFile={onOpenFile} />); const first = screen.getByRole("button", { name: /first\.ts/ }); fireEvent.keyDown(first, { key: "Enter", shiftKey: true }); expect(onOpenFile).toHaveBeenCalledWith(entries[0]);
  });
  it("opens the resolution workspace for a conflicted row", () => {
    const conflict: GitStatusEntry = { path: "src/conflict.ts", indexStatus: "U", worktreeStatus: "U", states: ["conflict"] }; const onOpenConflict = vi.fn();
    render(<GitChangesView entries={[conflict]} error="" onOpenDiff={vi.fn()} onOpenConflict={onOpenConflict} onOpenFile={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /conflict\.ts/ })); expect(onOpenConflict).toHaveBeenCalledWith(conflict);
  });
});
