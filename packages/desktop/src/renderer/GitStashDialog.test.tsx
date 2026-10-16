import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreClient } from "./client";

vi.mock("@monaco-editor/react", () => ({ DiffEditor: () => <div data-testid="diff" /> }));
afterEach(cleanup);
const stash = { reference: "stash@{0}", hash: "a".repeat(40), message: "WIP login", branch: "main", date: new Date().toISOString() };
it("creates a stash with the chosen inclusions, previews files and applies it", async () => {
  const { GitStashDialog } = await import("./GitStashDialog");
  let stashes: typeof stash[] = [];
  const request = vi.fn(async (type: string) => {
    if (type === "git.stashes") return { stashes };
    if (type === "git.createStash") { stashes = [stash]; return { stash }; }
    if (type === "git.stashPreview") return { stash, files: [{ path: "src/login.ts", status: "M" }], conflictRisk: "possible", blockers: ["src/login.ts"], recovery: "Applying keeps the stash." };
    if (type === "git.commitDiff") return { originalContent: "a", modifiedContent: "b" };
    if (type === "git.applyStash") return { applied: true, stashRetained: true, outcome: "Applied stash@{0}" };
    throw new Error(type);
  });
  const onChanged = vi.fn();
  render(<GitStashDialog client={{ request } as unknown as CoreClient} selectedPaths={["src/login.ts"]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(await screen.findByText("No stashes yet")).toBeTruthy();
  for (const label of ["Staged", "Unstaged", "Untracked", "Ignored", "Selected paths only (1)"]) expect(screen.getByText(label)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Untracked" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Stash message" }), { target: { value: "WIP login" } });
  fireEvent.click(screen.getByRole("button", { name: "Create stash" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("git.createStash", { include: { staged: true, unstaged: true, untracked: true, ignored: false }, message: "WIP login" }));
  expect((await screen.findByText(/May conflict/)).textContent).toContain("src/login.ts");
  await waitFor(() => expect(request).toHaveBeenCalledWith("git.commitDiff", { hash: stash.hash, path: "src/login.ts" }));
  await screen.findByTestId("diff");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect((await screen.findByText("Applied stash@{0}")).textContent).toBe("Applied stash@{0}");
  expect(onChanged).toHaveBeenCalledTimes(2);
});
