import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTrigger } from "@remote-ide/protocol";
import { TriggersPanel } from "./TriggersPanel";

afterEach(cleanup);
const trigger = (extra: Partial<WorkspaceTrigger> = {}): WorkspaceTrigger => ({ id: "trigger-a", rootId: "root", name: "Build watcher", enabled: true, fireCount: 2, createdAt: "2026-10-07T00:00:00.000Z", source: { type: "file", path: "/work/build.log", events: ["changed"] }, action: { type: "prompt", provider: "codex", prompt: "Review the failure" }, ...extra });
function setup(triggers: WorkspaceTrigger[] = []) {
  const onAction = vi.fn(async () => undefined);
  const onCreate = vi.fn(async () => undefined);
  const onError = vi.fn();
  render(<TriggersPanel triggers={triggers} workflows={[]} roots={[]} providers={[{ id: "codex", name: "Codex" } as never]} tasks={[]} defaultProvider="codex" onLoadAgents={async () => []} onCreate={onCreate} onAction={onAction} onRefresh={async () => undefined} onError={onError} />);
  return { onAction, onCreate, onError };
}

describe("Triggers tool window", () => {
  it("shows an empty state and opens the creation form", () => {
    setup();
    expect(screen.getByText("No triggers")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
    expect(screen.getByRole("form", { name: "New trigger" })).toBeTruthy();
  });

  it("describes the watched source, skips and errors and controls the exact trigger", async () => {
    const { onAction } = setup([trigger({ lastSkipped: "Target agent is busy", lastError: "Pipe failed", lastEvent: "changed: /work/build.log" })]);
    expect(screen.getByText("File /work/build.log · changed")).toBeTruthy();
    expect(screen.getByText("Skipped: Target agent is busy")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Pipe failed");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("trigger-a", "pause"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("trigger-a", "fire"));
  });

  it("creates a pipe trigger from the form", async () => {
    const { onCreate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pipe" } });
    fireEvent.change(screen.getByLabelText("Watch"), { target: { value: "fifo" } });
    fireEvent.change(screen.getByLabelText("Pipe path"), { target: { value: "/tmp/events" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Handle it" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create trigger" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create trigger" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Pipe", source: { type: "fifo", path: "/tmp/events" }, action: expect.objectContaining({ type: "prompt", prompt: "Handle it" }) })));
  });
});
