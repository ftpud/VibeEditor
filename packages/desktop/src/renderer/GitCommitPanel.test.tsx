import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommitPanel } from "./GitCommitPanel";

afterEach(() => { cleanup(); vi.useRealTimers(); });

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

  it("publishes only after typing has been idle", () => {
    vi.useFakeTimers();
    const onMessageChange = vi.fn();
    render(<GitCommitPanel message="" selectedCount={1} operationRunning={false} committing={false} onMessageChange={onMessageChange} onCommit={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(textarea, { target: { value: "F" } });
    fireEvent.change(textarea, { target: { value: "Fi" } });
    fireEvent.change(textarea, { target: { value: "Fix" } });
    expect(onMessageChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(onMessageChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMessageChange).toHaveBeenCalledOnce();
    expect(onMessageChange).toHaveBeenCalledWith("Fix");
  });

  it("publishes immediately on blur", () => {
    const onMessageChange = vi.fn();
    render(<GitCommitPanel message="" selectedCount={1} operationRunning={false} committing={false} onMessageChange={onMessageChange} onCommit={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(textarea, { target: { value: "Ready" } });
    fireEvent.blur(textarea);
    expect(onMessageChange).toHaveBeenCalledWith("Ready");
  });

  it("commits the latest local draft before its save timer fires", () => {
    vi.useFakeTimers();
    const onMessageChange = vi.fn(); const onCommit = vi.fn();
    render(<GitCommitPanel message="Old" selectedCount={1} operationRunning={false} committing={false} onMessageChange={onMessageChange} onCommit={onCommit} />);
    const textarea = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(textarea, { target: { value: "Newest message" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onMessageChange).toHaveBeenCalledWith("Newest message");
    expect(onCommit).toHaveBeenCalledWith("Newest message");
  });

  it("enables amend when the index has staged changes", () => {
    const onAmend = vi.fn();
    render(<GitCommitPanel message="" selectedCount={0} operationRunning={false} committing={false} onMessageChange={() => undefined} onCommit={vi.fn()} stagedCount={2} onAmend={onAmend} />);
    const amend = screen.getByRole("button", { name: "Amend staged (2)" }) as HTMLButtonElement;
    expect(amend.disabled).toBe(false);
    fireEvent.click(amend);
    expect(onAmend).toHaveBeenCalledOnce();
  });

  it("explains why amend is unavailable without staged changes", () => {
    render(<GitCommitPanel message="" selectedCount={0} operationRunning={false} committing={false} onMessageChange={() => undefined} onCommit={vi.fn()} stagedCount={0} onAmend={vi.fn()} />);
    const amend = screen.getByRole("button", { name: "Amend staged" }) as HTMLButtonElement;
    expect(amend.disabled).toBe(true);
    expect(amend.title).toBe("Stage changes before amending");
  });
});
