import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitCommitPatchDialog } from "./GitCommitPatchDialog";

afterEach(cleanup);
const preview = { hash: "a".repeat(40), indexVersion: "version", files: [{ path: "file.ts", hunks: [{ id: "first", content: "@@ -1 +1 @@\n-old\n+new\n" }, { id: "second", content: "@@ -20 +20 @@\n-before\n+after\n" }] }] };
it("submits only checked commit blocks and refreshes after applying", async () => {
  const request = vi.fn().mockResolvedValueOnce(preview).mockResolvedValueOnce({ applied: 1 });
  const onApplied = vi.fn(), onClose = vi.fn();
  render(<GitCommitPatchDialog client={{ request } as never} hash={preview.hash} label="Commit" onApplied={onApplied} onClose={onClose} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select file.ts block 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected blocks to index" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("git.applyCommitHunks", { hash: preview.hash, indexVersion: "version", hunkIds: ["second"] }));
  expect(onApplied).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});
it("keeps the selection and displays errors when the patch cannot apply", async () => {
  const request = vi.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error("Index changed. Refresh the patch."));
  const onClose = vi.fn();
  render(<GitCommitPatchDialog client={{ request } as never} hash={preview.hash} label="Commit" onApplied={vi.fn()} onClose={onClose} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select file.ts block 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected blocks to index" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Index changed");
  expect(onClose).not.toHaveBeenCalled();
});
