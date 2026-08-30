import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommitPanel } from "./GitCommitPanel";

afterEach(cleanup);

describe("GitCommitPanel", () => {
  const renderPanel = (onCommit = vi.fn(), message = "Describe the change", selectedCount = 2) => {
    render(<GitCommitPanel message={message} selectedCount={selectedCount} operationRunning={false} committing={false} onMessageChange={() => undefined} onCommit={onCommit} />);
    return { onCommit, textarea: screen.getByRole("textbox", { name: "Commit message" }) };
  };

  it("commits with Ctrl+Enter or Cmd+Enter", () => {
    const { onCommit, textarea } = renderPanel();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("keeps plain and modified Enter available for multiline messages", () => {
    const { onCommit, textarea } = renderPanel();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not run the shortcut when the commit is invalid", () => {
    const onCommit = vi.fn();
    const { textarea } = renderPanel(onCommit, "   ", 2);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("advertises the keyboard shortcut accessibly", () => {
    const { textarea } = renderPanel();
    expect(textarea.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
    expect(screen.getByText("Ctrl")).toBeTruthy();
  });
});
