import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimersPanel } from "./TimersPanel";
import type { WorkspaceSchedule } from "@remote-ide/protocol";

afterEach(cleanup);
function setup(schedules: WorkspaceSchedule[] = []) {
  const onAction = vi.fn(async () => undefined);
  const onScheduleAction = vi.fn(async () => undefined);
  const onError = vi.fn();
  render(<TimersPanel timers={[{ id: "hidden-timer", workspace: "/state/workflow-sessions/hash/session", provider: "codex", prompt: "Wake and check", dueAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-10-07T00:00:00.000Z" }]} schedules={schedules} workflows={[]} roots={[]} providers={[]} tasks={[]} runs={[]} defaultProvider="codex" onLoadAgents={async () => []} onCreateSchedule={async () => {}} onScheduleAction={onScheduleAction} onAction={onAction} onRefresh={async () => {}} onCancelAll={async () => {}} onError={onError} />);
  return { onAction, onScheduleAction, onError };
}

describe("Timers tool window", () => {
  it("shows hidden workflow timers and controls their exact IDs", async () => {
    const { onAction } = setup();
    expect(screen.getByText("Internal workflow session")).toBeTruthy();
    expect(screen.getByText("Wake and check")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel timer" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("hidden-timer", "cancel"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("hidden-timer", "fire"));
  });

  it("shows schedule launch errors and offers resume and deletion", async () => {
    const { onScheduleAction } = setup([{ id: "schedule-a", rootId: "root", name: "Daily review", enabled: false, intervalSeconds: 86400, dueAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-10-07T00:00:00.000Z", action: { type: "prompt", provider: "codex", prompt: "Review" }, lastError: "Target agent is busy" }]);
    expect(screen.getByRole("alert").textContent).toBe("Target agent is busy");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(onScheduleAction).toHaveBeenCalledWith("schedule-a", "resume"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onScheduleAction).toHaveBeenCalledWith("schedule-a", "delete"));
  });
});
