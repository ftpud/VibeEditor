import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageSnapshot } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { StoragePanel } from "./StoragePanel";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const snapshot = (): StorageSnapshot => ({ id: "scan-1", phase: "ready", updatedAt: new Date().toISOString(), server: "remote-server", paths: ["/managed/state"], totalBytes: 3000, scannedFiles: 4, message: "Usage calculated", warnings: [], categories: [
  { id: "tasks", label: "Task workspaces", description: "Task details", bytes: 2000, count: 2, segments: [{ id: "active", label: "Active", bytes: 1000 }, { id: "finished", label: "Finished", bytes: 1000 }], cleanable: { finished: 1000, older: 0, week: 0 } },
  { id: "sessions", label: "AI sessions", description: "Session details", bytes: 1000, count: 2, segments: [{ id: "older", label: "Older", bytes: 1000 }], cleanable: { finished: 0, older: 1000, week: 1000 } }
] });

describe("server storage panel", () => {
  it("requires explicit acknowledgement before closing sessions or discarding workspace changes", async () => {
    const data = snapshot(); data.categories[0]!.cleanable.inactive = 1000;
    data.categories.push({ id: "runtime", label: "Runtimes", description: "Runtime details", count: 2, bytes: 2000, segments: [], cleanable: { older: 0, week: 0, finished: 0, versions: 1000 } });
    const request = vi.fn(async () => data);
    render(<StoragePanel client={{ request } as unknown as CoreClient} onClose={vi.fn()} />); await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Keep current version" }));
    expect(screen.getByRole("button", { name: "Remove data" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Close other Vibe sessions for this SSH account" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove data" })); });
    expect(request).toHaveBeenCalledWith("storage.cleanup", { scanId: "scan-1", category: "runtime", age: "versions", closeOtherSessions: true });
    fireEvent.click(screen.getByRole("button", { name: "Keep root & active" }));
    expect(screen.getByRole("button", { name: "Remove data" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Discard uncommitted changes in inactive workspaces" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove data" })); });
    expect(request).toHaveBeenCalledWith("storage.cleanup", { scanId: "scan-1", category: "tasks", age: "inactive", discardChanges: true });
  });
  it("calculates on open, previews cleanup, and renders refreshed totals after deletion", async () => {
    const initial = snapshot(); const smaller = { ...snapshot(), id: "scan-2", totalBytes: 2000, message: "Cleanup complete", categories: snapshot().categories.map((row) => row.id === "sessions" ? { ...row, bytes: 0, segments: [], cleanable: { older: 0, week: 0, finished: 0 } } : row) };
    const request = vi.fn(async (type: string) => type === "storage.cleanup" ? smaller : initial);
    const client = { request } as unknown as CoreClient;
    const view = render(<StoragePanel client={client} onClose={vi.fn()} />);
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("storage.scan", {});
    expect(screen.getByText("remote-server · Shared Vibe storage for this SSH account")).toBeTruthy();
    expect(view.baseElement.querySelector(".storage-active")).toBeTruthy();
    expect(view.baseElement.querySelector(".storage-finished")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove older than 7 days" }));
    expect(request).not.toHaveBeenCalledWith("storage.cleanup", expect.anything());
    const confirm = screen.getByRole("alertdialog", { name: "Confirm storage cleanup" });
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Remove data" })); });
    expect(request).toHaveBeenCalledWith("storage.cleanup", { scanId: "scan-1", category: "sessions", age: "older" });
    expect(screen.getByText("Cleanup complete")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove older than 7 days" }).hasAttribute("disabled")).toBe(true);
    view.rerender(<StoragePanel client={client} onClose={vi.fn()} />);
    expect(request.mock.calls.filter(([type]) => type === "storage.scan")).toHaveLength(1);
  });
  it("polls a background scan, disables cleanup during scanning, and stops polling on close", async () => {
    vi.useFakeTimers(); const initial = snapshot();
    const request = vi.fn(async (type: string) => type === "storage.scan" ? { ...initial, phase: "scanning" } : initial);
    const onClose = vi.fn(); const view = render(<StoragePanel client={{ request } as unknown as CoreClient} onClose={onClose} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Remove finished" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(request).toHaveBeenCalledWith("storage.status", {});
    expect(screen.getByRole("button", { name: "Remove finished" }).hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(request).toHaveBeenCalledTimes(count);
  });
  it("shows server errors and allows a fresh scan", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("Server disconnected")).mockResolvedValue(snapshot());
    render(<StoragePanel client={{ request } as unknown as CoreClient} onClose={vi.fn()} />);
    await act(async () => {}); expect(screen.getByText("Server disconnected")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Recalculate" })); });
    expect(screen.queryByText("Server disconnected")).toBeNull();
    expect(request.mock.calls.filter(([type]) => type === "storage.scan")).toHaveLength(2);
  });
});
