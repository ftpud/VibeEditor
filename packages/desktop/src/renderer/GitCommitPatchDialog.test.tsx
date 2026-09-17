import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitCommitPatchDialog } from "./GitCommitPatchDialog";
import type { CoreClient } from "./client";
vi.mock("./CommitResultEditor", () => ({ CommitResultEditor: ({ path, result, onChange, preview }: { path: string; result: string; preview: { local: string }; onChange(value: string): void }) => <><pre aria-label="Local comparison">{preview.local}</pre><textarea aria-label={`Result for ${path}`} value={result} onChange={(event) => onChange(event.target.value)} /></> }));
vi.mock("./CommitBlockDiff", () => ({ CommitBlockDiff: ({ preview, selected }: { preview: { base: string; incoming: string }; selected: number }) => <div aria-label={`Source change for block ${selected + 1}`}><span>{preview.base}</span><span>{preview.incoming}</span></div> }));
afterEach(cleanup);
function setup(local = "old\n", failSave = false) {
  const request = vi.fn(async (type: string, payload: { path?: string }) => {
    if (type === "git.commitPatch") return { hash: "abc", indexVersion: "version", files: [{ path: "one.ts", indexContent: "old\n", hunks: [] }, { path: "two.ts", indexContent: "second\n", hunks: [] }] };
    if (type === "git.commitDiff") return payload.path === "one.ts" ? { originalContent: "old\n", modifiedContent: "new\n" } : { originalContent: "second\n", modifiedContent: "updated\n" };
    if (type === "filesystem.readFile") return { content: payload.path === "one.ts" ? local : "second\n", revision: { identity: payload.path!, version: `version-${payload.path}` } };
    if (failSave) throw new Error("The index changed after preview.");
    return { applied: 1 };
  });
  const onClose = vi.fn(); const onApplied = vi.fn();
  render(<GitCommitPatchDialog client={{ request } as unknown as CoreClient} hash="abc" label="Example" onClose={onClose} onApplied={onApplied} />);
  return { request, onClose, onApplied };
}
it("previews all blocks, navigates, preserves edits and stages the result", async () => {
  const { request, onApplied } = setup();
  const result = await screen.findByRole("textbox", { name: "Result for one.ts" }) as HTMLTextAreaElement;
  expect(result.value).toBe("new\n");
  expect(screen.getByLabelText("Local comparison").textContent).toBe("old\n");
  fireEvent.change(result, { target: { value: "manual\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Next block" }));
  expect((await screen.findByRole("textbox", { name: "Result for two.ts" }) as HTMLTextAreaElement).value).toBe("updated\n");
  fireEvent.click(screen.getByRole("button", { name: "Previous block" }));
  expect((screen.getByRole("textbox", { name: "Result for one.ts" }) as HTMLTextAreaElement).value).toBe("manual\n");
  fireEvent.click(screen.getByRole("button", { name: "Apply changes to local files" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith("git.saveCommitWorktreeResults", { hash: "abc", files: [{ path: "one.ts", content: "manual\n", expectedRevision: { identity: "one.ts", version: "version-one.ts" } }, { path: "two.ts", content: "updated\n", expectedRevision: { identity: "two.ts", version: "version-two.ts" } }] });
});
it("marks conflicts and blocks saving until resolved", async () => {
  setup("local edit\n");
  const result = await screen.findByRole("textbox", { name: "Result for one.ts" }) as HTMLTextAreaElement;
  expect(result.value).toContain("<<<<<<< LOCAL\nlocal edit\n=======\nnew\n");
  expect(screen.getByRole("button", { name: /Block 1 · Conflict/ }).className).toBe("conflict");
  expect((screen.getByRole("button", { name: "Apply changes to local files" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Source change for block 1").textContent).toBe("old\nnew\n");
  fireEvent.click(screen.getByRole("button", { name: "Apply exact change to result" }));
  expect(result.value).toBe("new\n");
  expect(screen.getByRole("button", { name: /Block 1 · Clean/ }).className).toBe("clean");
});
it("keeps the local block and protects unsaved drafts", async () => {
  const { onClose } = setup("local edit\n");
  const result = await screen.findByRole("textbox", { name: "Result for one.ts" }) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole("button", { name: "Keep target version" }));
  expect(result.value).toBe("local edit\n");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(result.value).toBe("local edit\n");
});
it("retains drafts on save failure", async () => {
  const { onClose } = setup("old\n", true);
  const result = await screen.findByRole("textbox", { name: "Result for one.ts" }) as HTMLTextAreaElement;
  fireEvent.change(result, { target: { value: "manual" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply changes to local files" }));
  expect((await screen.findByRole("alert")).textContent).toContain("index changed");
  expect(result.value).toBe("manual"); expect(onClose).not.toHaveBeenCalled();
});
