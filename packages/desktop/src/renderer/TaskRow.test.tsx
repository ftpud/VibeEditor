import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRow } from "./App";

afterEach(cleanup);

const summary = { status: "waiting" as const, waitingUntil: "2099-01-01T00:00:00.000Z", preview: "Later", additions: 0, deletions: 0, pendingPermission: false };

describe("task timer context actions", () => {
  it("offers cancel and immediate execution on right-click when a timer is active", () => {
    const cancel = vi.fn();
    const fire = vi.fn();
    const { container } = render(<TaskRow icon={null} name="Timed task" summary={summary} selected={false} disabled={false} onClick={vi.fn()} onCancelTimer={cancel} onFireTimer={fire} />);

    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Run timer now" }));
    expect(fire).toHaveBeenCalledOnce();

    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel timer" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("offers the same timer actions for the root workspace row", () => {
    const cancel = vi.fn();
    const fire = vi.fn();
    const { container } = render(<TaskRow icon={null} name="Root workspace" summary={summary} selected disabled={false} onClick={vi.fn()} onCancelTimer={cancel} onFireTimer={fire} />);

    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Run timer now" }));
    expect(fire).toHaveBeenCalledOnce();

    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel timer" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("hides timer actions when no timer is active", () => {
    render(<TaskRow icon={null} name="Idle task" summary={{ ...summary, status: "idle", waitingUntil: undefined }} selected={false} disabled={false} onClick={vi.fn()} onCancelTimer={vi.fn()} onFireTimer={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Run timer now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel timer" })).toBeNull();
  });

  it("marks a task finished and offers restore from its context menu", () => {
    const setFinished = vi.fn();
    const { container, rerender } = render(<TaskRow icon={null} name="Task" summary={{ ...summary, status: "idle", waitingUntil: undefined }} selected={false} disabled={false} onClick={vi.fn()} onSetFinished={setFinished} />);
    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Mark as Finished" }));
    expect(setFinished).toHaveBeenCalledOnce();

    rerender(<TaskRow icon={null} name="Task" summary={{ ...summary, status: "idle", waitingUntil: undefined }} finished selected={false} disabled={false} onClick={vi.fn()} onSetFinished={setFinished} />);
    fireEvent.contextMenu(container.querySelector(".task-row")!, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("button", { name: "Restore task" })).toBeTruthy();
    expect(container.querySelector(".task-row.finished")).toBeTruthy();
  });
});
