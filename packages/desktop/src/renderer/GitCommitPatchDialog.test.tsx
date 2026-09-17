import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitCommitPatchDialog, insertedBlock } from "./GitCommitPatchDialog";
import type { CoreClient } from "./client";

afterEach(cleanup);
const patch = { hash: "abc", indexVersion: "version", files: [
  { path: "one.txt", indexContent: "old\n", hunks: [{ id: "one", content: "@@ -1 +1 @@\n-old\n+new\n" }] },
  { path: "two.txt", indexContent: "second\n", hunks: [{ id: "two", content: "@@ -1 +1 @@\n-second\n+updated\n" }] }
] };
function setup() {
  const request = vi.fn(async (type: string) => type === "git.commitPatch" ? patch : { applied: 1 });
  const onClose = vi.fn(); const onApplied = vi.fn();
  render(<GitCommitPatchDialog client={{ request } as unknown as CoreClient} hash="abc" label="Example commit" onClose={onClose} onApplied={onApplied} />);
  return { request, onClose, onApplied };
}
it("navigates blocks, preserves drafts, and saves manually edited results", async () => {
  const { request, onApplied } = setup();
  const result = await screen.findByRole("textbox", { name: "Result for one.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Apply block to result" }));
  expect((result as HTMLTextAreaElement).value).toBe("new\n");
  fireEvent.change(result, { target: { value: "manual\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Next block" }));
  await screen.findByRole("textbox", { name: "Result for two.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Previous block" }));
  expect((screen.getByRole("textbox", { name: "Result for one.txt" }) as HTMLTextAreaElement).value).toBe("manual\n");
  fireEvent.click(screen.getByRole("button", { name: "Save results to index" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith("git.saveCommitResults", { hash: "abc", indexVersion: "version", files: [{ path: "one.txt", content: "manual\n" }] });
});
it("inserts added lines at the cursor and protects unsaved edits on close", async () => {
  const { onClose } = setup();
  const result = await screen.findByRole("textbox", { name: "Result for one.txt" }) as HTMLTextAreaElement;
  result.setSelectionRange(0, 0);
  fireEvent.click(screen.getByRole("button", { name: "Insert block at cursor" }));
  expect(result.value).toBe("new\nold\n");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(result.value).toBe("new\nold\n");
});
it("keeps conflicting manual edits and explains how to resolve a block", async () => {
  setup();
  const result = await screen.findByRole("textbox", { name: "Result for one.txt" }) as HTMLTextAreaElement;
  fireEvent.change(result, { target: { value: "conflict\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply block to result" }));
  expect(screen.getByRole("alert").textContent).toContain("does not match");
  expect(result.value).toBe("conflict\n");
});
it("preserves missing final newlines when inserting", () => {
  expect(insertedBlock("@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n")).toBe("new");
});
it("retains the draft when saving fails", async () => {
  const request = vi.fn().mockResolvedValueOnce(patch).mockRejectedValueOnce(new Error("The index changed after preview."));
  const onClose = vi.fn();
  render(<GitCommitPatchDialog client={{ request } as unknown as CoreClient} hash="abc" label="Commit" onApplied={vi.fn()} onClose={onClose} />);
  const result = await screen.findByRole("textbox", { name: "Result for one.txt" }) as HTMLTextAreaElement;
  fireEvent.change(result, { target: { value: "keep this edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save results to index" }));
  expect((await screen.findByRole("alert")).textContent).toContain("index changed");
  expect(result.value).toBe("keep this edit");
  expect(onClose).not.toHaveBeenCalled();
});
