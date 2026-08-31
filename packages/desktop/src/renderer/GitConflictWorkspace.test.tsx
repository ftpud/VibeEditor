import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitConflictWorkspaceDialog } from "./GitConflictWorkspace";

describe("GitConflictWorkspaceDialog", () => {
  it("navigates versions, submits an edited result, and gates continuation", async () => {
    const workspace = { operation: "merge" as const, files: [{ path: "file.txt", base: "base\n", ours: "ours\n", theirs: "theirs\n", result: "markers\n", resultDeleted: false }], canContinue: true, canAbort: true, recovery: "Resolve all files." };
    const resolved = { ...workspace, files: [] }; const request = vi.fn().mockResolvedValueOnce(workspace).mockResolvedValueOnce(resolved).mockResolvedValueOnce({ outcome: "done" }); const onChanged = vi.fn(); const onClose = vi.fn();
    render(<GitConflictWorkspaceDialog client={{ request } as never} initialPath="file.txt" onChanged={onChanged} onClose={onClose} />);
    await screen.findByText("file.txt"); const result = document.querySelector("textarea") as HTMLTextAreaElement; expect(result.value).toBe("markers\n"); expect(screen.getByRole("button", { name: /continue merge/i }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "theirs" })); expect(screen.getByLabelText(/theirs content/).textContent).toContain("theirs"); fireEvent.click(screen.getByRole("button", { name: "result" }));
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "combined\n" } }); fireEvent.click(screen.getByRole("button", { name: /mark result resolved/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("git.resolveConflict", { path: "file.txt", result: "combined\n" })); expect(screen.getByRole("button", { name: /continue merge/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /continue merge/i })); await waitFor(() => expect(request).toHaveBeenCalledWith("git.conflictAction", { action: "continue" })); expect(onChanged).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled();
  });
});
