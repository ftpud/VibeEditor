import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedWorkflowApp } from "@remote-ide/protocol";
import { ProcessesPanel } from "./ProcessesPanel";

afterEach(cleanup);
const process: ManagedWorkflowApp = { id: "app:launch", name: "Dev server", pid: 123, launcherPid: 122, command: "npm run dev", status: "descendants-running", processCount: 3, kind: "workflow-app", workspace: "/task", rootWorkspace: "/root", taskId: "task", taskName: "Fix UI", workflowRunId: "run", workflowBlockId: "block" };
function setup(props: Partial<React.ComponentProps<typeof ProcessesPanel>> = {}) {
  const onKill = vi.fn(async () => undefined); const onRefresh = vi.fn(async () => undefined);
  render(<ProcessesPanel processes={[process]} disabled={false} loading={false} onKill={onKill} onRefresh={onRefresh} {...props} />);
  return { onKill, onRefresh };
}
describe("Proc tool window", () => {
  it("shows command, PID and task/workflow/session context and kills the exact identity", async () => {
    const { onKill } = setup();
    expect(document.querySelector(".timers-total")?.textContent).toBe("1");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("npm run dev")).toBeTruthy(); expect(screen.getByText(/PID 123.*3 processes/)).toBeTruthy();
    expect(screen.getByText("Fix UI")).toBeTruthy(); expect(screen.getByText("Children running")).toBeTruthy(); expect(screen.getByText("Exited launcher PID: 122")).toBeTruthy(); expect(screen.getByText("Workflow: run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" })); await waitFor(() => expect(onKill).toHaveBeenCalledWith("app:launch"));
  });
  it("disables all actions while a kill is pending and renders actionable errors", async () => {
    let reject!: (error: Error) => void;
    setup({ onKill: () => new Promise((_resolve, failure) => { reject = failure; }) });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refresh workflow apps" }) as HTMLButtonElement).disabled).toBe(true);
    reject(new Error("Could not kill PID 123. Check Core permissions."));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check Core permissions"));
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("distinguishes loading, errors and an empty running list", () => {
    const view = render(<ProcessesPanel processes={[]} disabled={false} loading onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Loading workflow apps…");
    view.rerender(<ProcessesPanel processes={[]} disabled={false} loading={false} error="Could not read processes. Refresh to retry." onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Refresh to retry"); expect(screen.queryByText("No running workflow apps")).toBeNull();
    view.rerender(<ProcessesPanel processes={[]} disabled={false} loading={false} onKill={async () => {}} onRefresh={async () => {}} />);
    expect(screen.getByRole("status").textContent).toContain("No running workflow apps");
  });
});
