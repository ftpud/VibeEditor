import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiPermissionRequest } from "@remote-ide/protocol";
import { PermissionRequestActions, type PermissionRequestOwner } from "./PermissionRequestActions";
import { openTaskFromSummary } from "./permission-navigation";

afterEach(cleanup);

const request = (id: string, title = id): AiPermissionRequest => ({
  id, title, toolCallId: `tool-${id}`,
  options: [
    { optionId: "approve", name: "Approve", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" }
  ]
});

describe("inactive task permission navigation", () => {
  it("opens the AI pane and switches to the owning inactive task", () => {
    const openClassicAi = vi.fn();
    const openFocusedAi = vi.fn();
    const switchTask = vi.fn();
    openTaskFromSummary({ taskId: "task-b", pendingPermission: true, sideLayout: "ai-focused", openClassicAi, openFocusedAi, switchTask });
    expect(openFocusedAi).toHaveBeenCalledOnce();
    expect(openClassicAi).not.toHaveBeenCalled();
    expect(switchTask).toHaveBeenCalledWith("task-b");
  });
});

describe("permission request actions", () => {
  it("routes simultaneous task requests to their exact task, provider, conversation and request", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const ownerA: PermissionRequestOwner = { taskId: "task-a", provider: "codex", sessionId: "conversation-a" };
    const ownerB: PermissionRequestOwner = { taskId: "task-b", provider: "copilot", sessionId: "conversation-b" };
    render(<><PermissionRequestActions request={request("request-a", "Task A request")} owner={ownerA} onResolve={resolve} /><PermissionRequestActions request={request("request-b", "Task B request")} owner={ownerB} onResolve={resolve} /></>);
    fireEvent.click(within(screen.getByText("Task B request").closest("section")!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(ownerB, "request-b", "approve"));
    expect(resolve).not.toHaveBeenCalledWith(ownerA, expect.anything(), expect.anything());
  });

  it("routes approve, deny, and cancel without substituting the active task", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const owner: PermissionRequestOwner = { taskId: "inactive-task", provider: "codex", sessionId: "conversation-7" };
    const { rerender } = render(<PermissionRequestActions request={request("approve-request")} owner={owner} onResolve={resolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(owner, "approve-request", "approve"));
    rerender(<PermissionRequestActions request={request("deny-request")} owner={owner} onResolve={resolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(owner, "deny-request", "deny"));
    rerender(<PermissionRequestActions request={request("cancel-request")} owner={owner} onResolve={resolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(owner, "cancel-request", undefined));
  });

  it("disables actions during task switching and routes the replacement request after the switch", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const oldOwner: PermissionRequestOwner = { taskId: "task-a", provider: "codex", sessionId: "conversation-a" };
    const newOwner: PermissionRequestOwner = { taskId: "task-b", provider: "copilot", sessionId: "conversation-b" };
    const { rerender } = render(<PermissionRequestActions request={request("request-a")} owner={oldOwner} disabled onResolve={resolve} />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(resolve).not.toHaveBeenCalled();
    rerender(<PermissionRequestActions request={request("request-b")} owner={newOwner} onResolve={resolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(newOwner, "request-b", "approve"));
  });

  it("recovers when a request is stale or was resolved elsewhere", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("Permission request is no longer pending")).mockResolvedValue(undefined);
    const owner: PermissionRequestOwner = { taskId: "task-a", provider: "codex", sessionId: "conversation-a" };
    const { rerender } = render(<PermissionRequestActions request={request("stale-request")} owner={owner} onResolve={resolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer pending");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<PermissionRequestActions request={request("new-request")} owner={owner} onResolve={resolve} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(owner, "new-request", "approve"));
  });

  it("supports keyboard activation through native buttons", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn().mockResolvedValue(undefined);
    const owner: PermissionRequestOwner = { taskId: "task-a", provider: "codex", sessionId: "conversation-a" };
    render(<PermissionRequestActions request={request("keyboard-request")} owner={owner} onResolve={resolve} />);
    screen.getByRole("button", { name: "Deny" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(owner, "keyboard-request", "deny"));
  });

  it("prevents duplicate submission until the first action settles", async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const resolve = vi.fn(() => pending);
    render(<PermissionRequestActions request={request("duplicate-request")} owner={{ taskId: "task-a", provider: "codex" }} onResolve={resolve} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(true);
    settle();
    await pending;
  });
});
