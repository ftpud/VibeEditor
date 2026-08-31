import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitCommit, GitRebasePreview } from "@remote-ide/protocol";
import { GitRebaseDialog } from "./GitRebaseDialog";

const commit = (hash: string, subject: string): GitCommit => ({ hash: hash.repeat(40), shortHash: hash.repeat(7), author: "Test", date: "2026-08-31T00:00:00Z", subject });
const preview: GitRebasePreview = { branch: "feature", upstream: "origin/feature", base: "0".repeat(40), head: "3".repeat(40), upstreamHead: "0".repeat(40), items: [{ action: "pick", commit: commit("1", "one") }, { action: "pick", commit: commit("2", "two") }], truncated: false, blockers: [], recovery: "Use reflog." };

describe("GitRebaseDialog", () => {
  it("reorders commits, validates actions, edits reword messages, and submits the visible todo", () => {
    const confirm = vi.fn(); render(<GitRebaseDialog preview={preview} busy={false} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Move two up" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Action for two" }), { target: { value: "reword" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New message for two" }), { target: { value: "renamed two" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Action for one" }), { target: { value: "fixup" } });
    fireEvent.click(screen.getByRole("button", { name: "Start rebase" }));
    expect(confirm).toHaveBeenCalledWith([expect.objectContaining({ action: "reword", message: "renamed two", commit: expect.objectContaining({ subject: "two" }) }), expect.objectContaining({ action: "fixup", commit: expect.objectContaining({ subject: "one" }) })]);
  });

  it("shows upstream blockers and disables mutation", () => {
    const { container } = render(<GitRebaseDialog preview={{ ...preview, blockers: ["Upstream is ahead."] }} busy={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Upstream is ahead"); expect((container.querySelector("button.primary") as HTMLButtonElement).disabled).toBe(true);
  });
});
