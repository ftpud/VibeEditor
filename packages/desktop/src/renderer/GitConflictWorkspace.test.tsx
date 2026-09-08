import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitConflictWorkspaceDialog } from "./GitConflictWorkspace";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, options, language }: { value: string; onChange(value: string): void; options: { ariaLabel: string; readOnly: boolean }; language: string }) => <textarea readOnly={options.readOnly} aria-label={options.ariaLabel} data-language={language} value={value} onChange={(event) => onChange(event.target.value)} />,
  DiffEditor: ({ original, modified, language }: { original: string; modified: string; language: string }) => <div data-testid="comparison" data-language={language}><pre data-testid="original">{original}</pre><pre data-testid="modified">{modified}</pre></div>
}));

afterEach(cleanup);
describe("GitConflictWorkspaceDialog", () => {
  it("navigates versions, submits an edited result, and gates continuation", async () => {
    const workspace = { operation: "merge" as const, files: [{ path: "file.txt", base: "base\n", ours: "ours\n", theirs: "theirs\n", result: "markers\n", resultDeleted: false }], canContinue: true, canAbort: true, recovery: "Resolve all files." };
    const resolved = { ...workspace, files: [] }; const request = vi.fn().mockResolvedValueOnce(workspace).mockResolvedValueOnce(resolved).mockResolvedValueOnce({ outcome: "done" }); const onChanged = vi.fn(); const onClose = vi.fn();
    render(<GitConflictWorkspaceDialog client={{ request } as never} initialPath="file.txt" onChanged={onChanged} onClose={onClose} />);
    const result = await screen.findByRole("textbox", { name: /Resolution result for/ }) as HTMLTextAreaElement; expect(result.value).toBe("markers\n"); expect(screen.getByRole("button", { name: /continue merge/i }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("textbox", { name: "ours for file.txt" }) as HTMLTextAreaElement).value).toBe("ours\n");
    fireEvent.change(screen.getByRole("textbox", { name: /Resolution result for/ }), { target: { value: "combined\n" } }); fireEvent.click(screen.getByRole("button", { name: /mark result resolved/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("git.resolveConflict", { path: "file.txt", result: "combined\n" })); expect(screen.getByRole("button", { name: /continue merge/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /continue merge/i })); await waitFor(() => expect(request).toHaveBeenCalledWith("git.conflictAction", { action: "continue" })); expect(onChanged).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled();
  });
  it("preserves drafts between files and lets a version be reviewed before staging", async () => {
    const request = vi.fn().mockResolvedValue({ operation: "merge", files: [
      { path: "one.ts", ours: "const a = 1;", theirs: "const a = 2;", result: "markers", resultDeleted: false },
      { path: "two.ts", theirs: "second", result: "second markers", resultDeleted: false }
    ], canContinue: true, canAbort: true, recovery: "Resolve all files." });
    render(<GitConflictWorkspaceDialog client={{ request } as never} initialPath="one.ts" onChanged={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("textbox", { name: /Resolution result for/ });
    expect(screen.getByRole("textbox", { name: /Resolution result for/ }).getAttribute("data-language")).toBe("typescript");
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
    expect((screen.getByRole("textbox", { name: /Resolution result for/ }) as HTMLTextAreaElement).value).toBe("const a = 2;");
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "two.ts" }));
    expect(screen.getByRole("button", { name: "Use ours" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Not present/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /one.ts/ }));
    expect((screen.getByRole("textbox", { name: /Resolution result for/ }) as HTMLTextAreaElement).value).toBe("const a = 2;");
  });
});
