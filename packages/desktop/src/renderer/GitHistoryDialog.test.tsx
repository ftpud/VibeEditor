import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreClient } from "./client";
import { selectedLineRange } from "./App";

vi.mock("@monaco-editor/react", () => ({ DiffEditor: () => null }));
afterEach(cleanup);
it("sends the editor buffer, diffs each commit at its historical path and shows Core's note", async () => {
  const { GitHistoryDialog } = await import("./GitHistoryDialog");
  const request = vi.fn(async (type: string) => type === "git.fileHistory"
    ? { commits: [{ hash: "a".repeat(40), shortHash: "aaaaaaa", author: "Dev", date: "2026-01-01", subject: "Before rename", path: "old.txt" }], range: { startLine: 15, endLine: 15 }, note: "showing the history of committed lines 15-15" }
    : { originalContent: "", modifiedContent: "x" });
  render(<GitHistoryDialog client={{ request } as unknown as CoreClient} path="new.txt" startLine={18} endLine={18} content="buffer" onClose={vi.fn()} />);
  expect((await screen.findByRole("status")).textContent).toContain("committed lines 15-15");
  expect(request).toHaveBeenCalledWith("git.fileHistory", { path: "new.txt", startLine: 18, endLine: 18, content: "buffer" });
  await waitFor(() => expect(request).toHaveBeenCalledWith("git.commitDiff", { hash: "a".repeat(40), path: "old.txt" }));
  expect(screen.getByText(/old\.txt/)).toBeTruthy();
});
it("excludes the line a selection only touches at column 1", () => {
  expect(selectedLineRange({ startLineNumber: 3, endLineNumber: 6, endColumn: 1 })).toEqual({ startLine: 3, endLine: 5 });
  expect(selectedLineRange({ startLineNumber: 3, endLineNumber: 6, endColumn: 4 })).toEqual({ startLine: 3, endLine: 6 });
  expect(selectedLineRange({ startLineNumber: 3, endLineNumber: 3, endColumn: 1 })).toEqual({ startLine: 3, endLine: 3 });
});
