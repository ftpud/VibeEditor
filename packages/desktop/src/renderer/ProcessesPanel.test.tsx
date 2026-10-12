import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcess } from "@remote-ide/protocol";
import { ProcessesPanel } from "./ProcessesPanel";

afterEach(cleanup);
const process: ManagedProcess = { id: "123:ticks", pid: 123, command: "npm run dev", status: "running", kind: "command", workspace: "/task", rootWorkspace: "/root", taskId: "task", taskName: "Fix UI", sessionId: "chat", provider: "any-provider", workflowRunId: "run", workflowBlockId: "block" };
function setup(props: Partial<React.ComponentProps<typeof ProcessesPanel>> = {}) {
  const onKill = vi.fn(async () => undefined); const onRefresh = vi.fn(async () => undefined);
  render(<ProcessesPanel processes={[process]} providers={[]} disabled={false} loading={false} onKill={onKill} onRefresh={onRefresh} {...props} />);
  return { onKill, onRefresh };
}
describe("Proc tool window", () => {
  it("shows command, PID and task/workflow/session context and kills the exact identity", async () => {
    const { onKill } = setup();
    expect(screen.getByText("npm run dev")).toBeTruthy(); expect(screen.getByText(/PID 123.*any-provider/)).toBeTruthy();
    expect(screen.getByText("Fix UI")).toBeTruthy(); expect(screen.getByText("Session: chat")).toBeTruthy(); expect(screen.getByText("Workflow: run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kill" })); await waitFor(() => expect(onKill).toHaveBeenCalledWith("123:ticks"));
  });
  it("disables all actions while a kill is pending and renders actionable errors", async () => {
    let reject!: (error: Error) => void;
    setup({ onKill: () => new Promise((_resolve, failure) => { reject = failure; }) });
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect((screen.getByRole("button", { name: "Kill" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refresh processes" }) as HTMLButtonElement).disabled).toBe(true);
    reject(new Error("Could not kill PID 123. Check Core permissions."));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check Core permissions"));
    expect((screen.getByRole("button", { name: "Kill" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("distinguishes loading, errors and an empty running list", () => {
    const view = render(<ProcessesPanel processes={[]} providers={[]} disabled={false} loading onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Loading processes…");
    view.rerender(<ProcessesPanel processes={[]} providers={[]} disabled={false} loading={false} error="Could not read processes. Refresh to retry." onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Refresh to retry"); expect(screen.queryByText("No running AI processes")).toBeNull();
    view.rerender(<ProcessesPanel processes={[]} providers={[]} disabled={false} loading={false} onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("status").textContent).toContain("No running AI processes");
  });
});
