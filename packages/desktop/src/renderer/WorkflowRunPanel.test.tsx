import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { BlockRunDetails, HarnessPanel } from "./HarnessPanel";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workflow: HarnessDefinition = { id: "flow", name: "Workspace check", version: 1, createdAt: "now", updatedAt: "now", blocks: [
  { id: "button", type: "start_button", label: "Quick check", prompt: "Check workspace", position: { x: 0, y: 0 } },
  { id: "input", type: "start_input", label: "Custom goal", prompt: "", position: { x: 0, y: 100 } },
  { id: "agent", type: "ai", label: "Inspect", prompt: "{{input}}", position: { x: 300, y: 0 } },
], edges: [{ id: "edge", from: "button", to: "agent" }] };
const run: HarnessRun = { id: "run", harnessId: workflow.id, harnessVersion: 1, definition: workflow, input: "Check workspace", status: "running", createdAt: "2026-10-07T12:00:00Z", blocks: [{ blockId: "button", status: "succeeded" }, { blockId: "agent", status: "running" }] };
const props = () => ({ harnesses: [workflow], runs: [], onRun: vi.fn().mockResolvedValue(run), onCancelRun: vi.fn().mockResolvedValue(undefined), onError: vi.fn() });

describe("Workflow run library", () => {
  it("loads full run details only when the workflow is opened", async () => {
    const summary: HarnessRun = { ...run, summary: true, definition: undefined, input: "", blocks: run.blocks.map(({ blockId, status }) => ({ blockId, status })) };
    let resolve!: (run: HarnessRun) => void;
    const onReadRun = vi.fn(() => new Promise<HarnessRun>((done) => { resolve = done; }));
    const view = render(<WorkflowRunPanel {...props()} runs={[summary]} onReadRun={onReadRun} />);
    expect(onReadRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    await waitFor(() => expect(onReadRun).toHaveBeenCalledWith("run"));
    expect(screen.getByText("Loading run details…")).toBeTruthy();
    resolve(run);
    view.rerender(<WorkflowRunPanel {...props()} runs={[run]} onReadRun={onReadRun} />);
    expect(screen.getByRole("button", { name: "Inspect: running" })).toBeTruthy();
    expect(onReadRun).toHaveBeenCalledTimes(1);
  });

  it("changes Autopilot on the selected Chatbox session while it waits for permission", async () => {
    const chatWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "chat", type: "chatbox", label: "Assistant", prompt: "", position: { x: 0, y: 0 } }], edges: [] };
    const chatRun: HarnessRun = { ...run, definition: chatWorkflow, status: "awaiting_permission", blocks: [{ blockId: "chat", status: "awaiting_permission", sessionId: "owned-session", autopilot: false }] };
    const onAutopilot = vi.fn().mockResolvedValue({ ...chatRun, blocks: [{ ...chatRun.blocks[0], autopilot: true }] });
    render(<WorkflowRunPanel {...props()} harnesses={[chatWorkflow]} runs={[chatRun]} onAutopilot={onAutopilot} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Assistant: awaiting permission" }));
    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }));
    await waitFor(() => expect(onAutopilot).toHaveBeenCalledWith("run", "chat", "owned-session", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Autopilot" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("sends steering to the selected Chatbox session and retains stop", async () => {
    const chatWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "chat", type: "chatbox", label: "Assistant", prompt: "", position: { x: 0, y: 0 } }], edges: [] };
    const chatRun: HarnessRun = { ...run, definition: chatWorkflow, blocks: [{ blockId: "chat", status: "running", sessionId: "session" }] };
    const onSteerChat = vi.fn().mockResolvedValue(chatRun);
    render(<WorkflowRunPanel {...props()} harnesses={[chatWorkflow]} runs={[chatRun]} onChat={vi.fn()} onSteerChat={onSteerChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Assistant: running" }));
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "Focus on tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer chat response" }));
    await waitFor(() => expect(onSteerChat).toHaveBeenCalledWith("run", "chat", "session", "Focus on tests"));
    expect(screen.getByRole("button", { name: "Stop chat response" })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Message Assistant") as HTMLTextAreaElement).value).toBe(""));
  });

  it("opens live app output from the selected saved run", async () => {
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "app", type: "run_app", label: "Server", prompt: "", app: { name: "server", actions: ["start"] }, position: { x: 0, y: 0 } }], edges: [] };
    const appRun: HarnessRun = { ...run, definition: appWorkflow, status: "succeeded", blocks: [{ blockId: "app", status: "succeeded" }] };
    const onOpenAppTerminal = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowRunPanel {...props()} harnesses={[appWorkflow]} runs={[appRun]} onOpenAppTerminal={onOpenAppTerminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Server: succeeded" }));
    fireEvent.click(screen.getByRole("button", { name: "Open app output in terminal" }));
    await waitFor(() => expect(onOpenAppTerminal).toHaveBeenCalledWith("flow", "app", "run"));
  });

  it("shows the immutable bound task and its Core-resolved worktree", () => {
    render(<WorkflowRunPanel {...props()} runs={[{ ...run, binding: { rootWorkspace: "/root", workspace: "/task-a", taskId: "a", taskName: "Task A" } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByText(/Task A ·/).getAttribute("title")).toBe("/task-a");
  });
  it.each(["running", "descendants-running"] as const)("fits each axis and kills a %s app from a completed run", async (appStatus) => {
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "app", type: "run_app", label: "Server", prompt: "", command: "npm run dev", app: { name: "server", actions: ["start"] }, position: { x: 0, y: 0 } }] };
    const appRun: HarnessRun = { ...run, status: "succeeded", definition: appWorkflow, blocks: [{ blockId: "app", status: "succeeded" }] };
    const onReadApp = vi.fn().mockResolvedValue({ name: "server", status: appStatus, output: "Listening on port 3000\nerror stream", pid: 123 });
    const onKillApp = vi.fn(async () => { onReadApp.mockResolvedValue({ name: "server", status: "exited", output: "Listening on port 3000\nerror stream", pid: 123, signal: "SIGKILL" }); });
    render(<WorkflowRunPanel {...props()} harnesses={[appWorkflow]} runs={[appRun]} onKillApp={onKillApp} onReadApp={onReadApp} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    const preview = screen.getByLabelText("Live workflow tree");
    preview.style.padding = "4px";
    Object.defineProperties(preview, { clientWidth: { value: 400 }, clientHeight: { value: 220 } });
    fireEvent.click(screen.getByRole("button", { name: "Fit workflow horizontally" }));
    expect(Number(preview.querySelector("svg")!.getAttribute("width"))).toBe(392);
    fireEvent.click(screen.getByRole("button", { name: "Fit workflow vertically" }));
    expect(Number(preview.querySelector("svg")!.getAttribute("height"))).toBe(212);
    const appBlock = await screen.findByRole("button", { name: appStatus === "descendants-running" ? "Server: succeeded · Children running in background" : "Server: succeeded · Running in background" });
    expect(appBlock.classList.contains("background-running")).toBe(true);
    fireEvent.click(appBlock);
    expect(await screen.findByText(/Listening on port 3000/)).toBeTruthy();
    expect(onReadApp).toHaveBeenCalledWith("flow", "app", "run");
    if (appStatus === "descendants-running") expect(await screen.findByText("Children running")).toBeTruthy();
    const kill = screen.getByRole("button", { name: "Kill process" });
    expect(kill.closest("header")).toBeTruthy();
    expect(kill.textContent).toBe("");
    fireEvent.click(kill);
    await waitFor(() => expect(onKillApp).toHaveBeenCalledWith("flow", "app", "run"));
    expect(await screen.findByText("Exited · SIGKILL")).toBeTruthy();
    await waitFor(() => expect(appBlock.classList.contains("background-running")).toBe(false), { timeout: 2500 });
    expect(appBlock.getAttribute("aria-label")).toBe("Server: succeeded");
  });

  it.each([{ viewportWidth: 120, hasRun: false }, { viewportWidth: 800, hasRun: false }, { viewportWidth: 120, hasRun: true }, { viewportWidth: 800, hasRun: true }])("fits from the top toolbar at width $viewportWidth with run=$hasRun", async ({ viewportWidth, hasRun }) => {
    const user = userEvent.setup();
    render(<WorkflowRunPanel {...props()} runs={hasRun ? [{ ...run, status: "succeeded" }] : []} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    const preview = screen.getByLabelText("Live workflow tree");
    const horizontal = screen.getByRole("button", { name: "Fit workflow horizontally" });
    const vertical = screen.getByRole("button", { name: "Fit workflow vertically" });
    const controls = horizontal.closest(".workflow-run-controls")!;
    expect(controls.contains(vertical)).toBe(true);
    expect(controls.parentElement?.classList.contains("workflow-run-prompt-row")).toBe(true);
    expect([...controls.querySelectorAll("button")].slice(0, 2)).toEqual([horizontal, vertical]);
    expect(controls.querySelector(".workflow-control-separator") !== null).toBe(hasRun);
    if (hasRun) expect(controls.contains(screen.getByRole("button", { name: "New run" }))).toBe(true);
    expect(document.querySelector(".workflow-preview-controls")).toBeNull();
    expect(document.querySelector(".workflow-preview-viewport")).toBeNull();
    expect(preview.contains(horizontal)).toBe(false);
    expect(horizontal.title).toBe("Fit horizontally");
    expect(vertical.title).toBe("Fit vertically");
    preview.style.padding = "4px";
    Object.defineProperties(preview, { clientWidth: { value: viewportWidth }, clientHeight: { value: 220 } });
    preview.scrollLeft = 80;
    preview.scrollTop = 40;
    horizontal.focus();
    await user.keyboard("{Enter}");
    expect(Number(preview.querySelector("svg")!.getAttribute("width"))).toBeCloseTo(viewportWidth - 8);
    expect(preview.scrollLeft).toBe(0);
    expect(preview.scrollTop).toBe(0);
    await user.tab();
    expect(document.activeElement).toBe(vertical);
    await user.keyboard(" ");
    expect(Number(preview.querySelector("svg")!.getAttribute("height"))).toBeCloseTo(212);
    expect(preview.style.height).toBe("220px");
    await user.click(horizontal);
    expect(preview.style.height).toBe("");
  });

  it("refreshes app output while details are open", async () => {
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "app", type: "run_app", label: "Server", prompt: "", app: { name: "server", actions: ["start"] }, position: { x: 0, y: 0 } }], edges: [] };
    const onReadApp = vi.fn().mockResolvedValueOnce({ name: "server", status: "running", output: "first line" }).mockResolvedValue({ name: "server", status: "running", output: "first line\nsecond line" });
    render(<WorkflowRunPanel {...props()} harnesses={[appWorkflow]} onReadApp={onReadApp} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Server: idle" }));
    await waitFor(() => expect(screen.getByLabelText("App stdout and stderr").textContent).toContain("first line"));
    await waitFor(() => expect(screen.getByLabelText("App stdout and stderr").textContent).toContain("second line"), { timeout: 2500 });
  });

  it("collapses workflow list items by default and opens them on demand", () => {
    render(<WorkflowRunPanel {...props()} />);
    expect(screen.getByRole("button", { name: "Show Workspace check" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Start Quick check" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Workspace check" }));
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Workspace check" }));
    expect(screen.queryByRole("button", { name: "Start Quick check" })).toBeNull();
  });

  it("opens a Chatbox before a run and sends follow-up messages to the same conversation", async () => {
    const chatWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "chat", type: "chatbox", label: "Assistant", prompt: "", position: { x: 0, y: 0 } }, workflow.blocks[2]!], edges: [{ id: "tool", from: "chat", to: "agent", type: "use" }] };
    const chatRun: HarnessRun = { ...run, definition: chatWorkflow, status: "succeeded", blocks: [{ blockId: "chat", status: "succeeded", chatMessages: [{ id: "user", role: "user", text: "Hello", timestamp: "now" }, { id: "reply", role: "assistant", text: "**Hello back**", timestamp: "now" }] }] };
    const onChat = vi.fn().mockResolvedValue(chatRun);
    const callbacks = { ...props(), harnesses: [chatWorkflow], onChat };
    const view = render(<WorkflowRunPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Assistant: idle" }));
    expect(screen.getByLabelText("Connected chat tools").textContent).toContain("Inspect");
    const input = screen.getByLabelText("Message Assistant");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onChat).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChat).toHaveBeenCalledWith("flow", "chat", "Hello", undefined));
    expect(await screen.findByText("Hello back", { selector: "strong" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "Next message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send chat message" }));
    await waitFor(() => expect(onChat).toHaveBeenLastCalledWith("flow", "chat", "Next message", "run"));
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...chatRun, status: "running", blocks: [{ ...chatRun.blocks[0]!, status: "running" }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop chat response" }));
    await waitFor(() => expect(callbacks.onCancelRun).toHaveBeenCalledWith("run"));
  });

  it("keeps a failed Chatbox message in the composer for retry", async () => {
    const chatWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "chat", type: "chatbox", label: "Assistant", prompt: "", position: { x: 0, y: 0 } }], edges: [] };
    const onChat = vi.fn().mockRejectedValue(new Error("Provider offline"));
    render(<WorkflowRunPanel {...props()} harnesses={[chatWorkflow]} onChat={onChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Assistant: idle" }));
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "Keep this message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send chat message" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Provider offline");
    expect(screen.getByLabelText("Message Assistant")).toHaveProperty("value", "Keep this message");
  });

  it("offers every start and replaces launch controls with a live preview after starting", async () => {
    const callbacks = props();
    const view = render(<WorkflowRunPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Custom goal" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start Quick check" }));
    await waitFor(() => expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Check workspace", "button", undefined));
    await screen.findByLabelText("Live workflow tree");
    expect(screen.queryByRole("button", { name: "Start Quick check" })).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect: running" })).toBeTruthy();
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "succeeded", blocks: [{ blockId: "agent", status: "succeeded" }] }]} />);
    expect(screen.getByRole("button", { name: "Inspect: succeeded" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop run run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
  });

  it("places icon controls beside the prompt and reruns the selected snapshot while pending", async () => {
    const user = userEvent.setup();
    const historical: HarnessRun = { ...run, id: "historical", status: "succeeded", input: "Saved prompt", createdAt: "2026-10-01T12:00:00Z" };
    const next: HarnessRun = { ...run, id: "next" };
    let resolveRun!: (value: HarnessRun) => void;
    const callbacks = { ...props(), onRun: vi.fn(() => new Promise<HarnessRun>((resolve) => { resolveRun = resolve; })) };
    render(<WorkflowRunPanel {...callbacks} runs={[run, historical]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Run for Workspace check" }), { target: { value: "historical" } });
    const newRun = screen.getByRole("button", { name: "New run" });
    const rerun = screen.getByRole("button", { name: "Rerun" });
    const promptRow = document.querySelector(".workflow-run-prompt-row")!;
    expect(promptRow.contains(newRun)).toBe(true);
    expect(promptRow.contains(rerun)).toBe(true);
    expect(promptRow.querySelector("summary")?.textContent).toBe("Run prompt");
    for (const button of [newRun, rerun]) {
      expect(button.textContent).toBe("");
      expect(button.title).toBeTruthy();
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    newRun.focus();
    await user.keyboard("{Enter}");
    expect(newRun.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(rerun);
    await user.keyboard(" ");
    expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Saved prompt", undefined, "historical");
    expect(rerun.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Start Quick check" }).hasAttribute("disabled")).toBe(true);
    await user.click(rerun);
    expect(callbacks.onRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop run run" }));
    await waitFor(() => expect(callbacks.onCancelRun).toHaveBeenCalledWith("run"));
    resolveRun(next);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Run for Workspace check" })).toHaveProperty("value", "next"));
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start Quick check" })).toBeNull();
    expect(newRun.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"] as const)("keeps New run and Stop available for %s runs", async (status) => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.queryByRole("button", { name: "Start Quick check" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop run run" }));
    await waitFor(() => expect(callbacks.onCancelRun).toHaveBeenCalledWith("run"));
  });

  it("omits the action row for completed runs and preserves snapshot availability", () => {
    const callbacks = props();
    const view = render(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "succeeded" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByRole("button", { name: "Rerun" })).toBeTruthy();
    expect(document.querySelector(".workflow-card-actions")).toBeNull();
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "succeeded", definition: undefined }]} />);
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
    expect(screen.getByRole("button", { name: "New run" })).toBeTruthy();
  });

  it("keeps starting points directly available on cards without a run", () => {
    render(<WorkflowRunPanel {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.queryByRole("button", { name: "New run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rerun" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop run/ })).toBeNull();
    expect(document.querySelector(".workflow-card-actions")).toBeNull();
    expect(screen.getByRole("button", { name: "Start Quick check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Custom goal" }).hasAttribute("disabled")).toBe(true);
  });

  it("places run-wide Stop icons beside New run and Rerun and handles cancellation feedback", async () => {
    const user = userEvent.setup();
    const otherRun: HarnessRun = { ...run, id: "other", createdAt: "2026-10-06T12:00:00Z" };
    const completedRun: HarnessRun = { ...run, id: "completed", status: "succeeded" };
    let rejectCancel!: (error: Error) => void;
    const onCancelRun = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectCancel = reject; }));
    const callbacks = { ...props(), onCancelRun };
    const view = render(<WorkflowRunPanel {...callbacks} runs={[run, otherRun, completedRun]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Run for Workspace check" }), { target: { value: "completed" } });
    const controls = document.querySelector<HTMLElement>(".workflow-run-controls")!;
    const stop = within(controls).getByRole("button", { name: "Stop run run" });
    const otherStop = within(controls).getByRole("button", { name: "Stop run other" });
    expect(within(controls).getByRole("button", { name: "New run" })).toBeTruthy();
    expect(within(controls).getByRole("button", { name: "Rerun" })).toBeTruthy();
    expect(document.querySelector(".workflow-card-actions")).toBeNull();
    expect(stop.textContent).toBe("");
    expect(stop.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(stop.title).toBe("Stop workflow run run");
    stop.focus();
    await user.keyboard("{Enter}");
    expect(onCancelRun).toHaveBeenCalledWith("run");
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(stop.title).toBe("Stopping workflow run run");
    expect(otherStop.hasAttribute("disabled")).toBe(false);
    await user.click(stop);
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    rejectCancel(new Error("Cancellation failed"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cancellation failed");
    expect(callbacks.onError).toHaveBeenCalledWith("Cancellation failed");
    expect(stop.hasAttribute("disabled")).toBe(false);
    expect(stop.getAttribute("aria-busy")).toBe("false");
    onCancelRun.mockImplementation(async () => undefined);
    await user.click(stop);
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    expect(onCancelRun).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Run for Workspace check" })).toHaveProperty("value", "completed");
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "cancelled" }, otherRun, completedRun]} />);
    expect(screen.queryByRole("button", { name: "Stop run run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop run other" })).toBeTruthy();
    expect(document.querySelector(".workflow-card-actions")).toBeNull();
  });

  it.each(["stop", "run now"] as const)("handles compact timer %s with pending, error, and transition feedback", async (action) => {
    const user = userEvent.setup();
    const timerLabel = "A long armed workflow timer label";
    const timerWorkflow: HarnessDefinition = { ...workflow, blocks: [{ ...workflow.blocks[2]!, label: timerLabel }] };
    const timerRun: HarnessRun = { ...run, definition: timerWorkflow, status: "waiting_timer", blocks: [{ blockId: "agent", status: "waiting_timer", pauseId: "timer-pause", waitingUntil: "2099-01-01T12:30:00.000Z" }] };
    let rejectAction!: (error: Error) => void;
    const operation = vi.fn(() => new Promise<HarnessRun>((_resolve, reject) => { rejectAction = reject; }));
    const callbacks = { ...props(), onResumePause: action === "run now" ? operation : vi.fn(), onCancelPause: action === "stop" ? operation : vi.fn() };
    const view = render(<WorkflowRunPanel {...callbacks} harnesses={[timerWorkflow]} runs={[timerRun]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    const strip = screen.getByRole("region", { name: `${timerLabel} timer pause` });
    expect(strip.classList.contains("workflow-timer-strip")).toBe(true);
    expect(strip.classList.contains("harness-pause")).toBe(false);
    expect(strip.querySelector("strong")?.title).toContain(timerLabel);
    const due = strip.querySelector("time")!;
    expect(due.dateTime).toBe("2099-01-01T12:30:00.000Z");
    expect(due.textContent).toContain("Due");
    expect(due.title).toContain("Scheduled for");
    const stop = within(strip).getByRole("button", { name: `Stop timer for ${timerLabel}` });
    const resume = within(strip).getByRole("button", { name: `Run timer now for ${timerLabel}` });
    expect(stop.title).toContain("cancel");
    expect(resume.title).toContain("immediately");
    const button = action === "stop" ? stop : resume;
    button.focus();
    await user.keyboard("{Enter}");
    expect(operation).toHaveBeenCalledWith("run", "agent", "timer-pause");
    expect(strip.getAttribute("aria-busy")).toBe("true");
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(resume.hasAttribute("disabled")).toBe(true);
    await user.click(button);
    expect(operation).toHaveBeenCalledTimes(1);
    rejectAction(new Error("Timer operation failed"));
    expect(await within(strip).findByRole("alert")).toHaveProperty("textContent", "Timer operation failed");
    expect(callbacks.onError).toHaveBeenCalledWith("Timer operation failed");
    expect(strip.classList.contains("failed")).toBe(true);
    expect(strip.getAttribute("aria-busy")).toBe("false");
    expect(button.hasAttribute("disabled")).toBe(false);
    operation.mockImplementation(async () => timerRun);
    await user.click(button);
    await waitFor(() => expect(strip.getAttribute("aria-busy")).toBe("false"));
    expect(within(strip).queryByRole("alert")).toBeNull();
    expect(strip.querySelector("time")).toBeTruthy();
    expect(strip.classList.contains("failed")).toBe(false);
    view.rerender(<WorkflowRunPanel {...callbacks} harnesses={[timerWorkflow]} runs={[{ ...timerRun, status: action === "stop" ? "cancelled" : "running", blocks: [{ blockId: "agent", status: action === "stop" ? "cancelled" : "running" }] }]} />);
    expect(screen.queryByRole("region", { name: `${timerLabel} timer pause` })).toBeNull();
  });

  it("keeps timer actions disabled without a pause identity or callbacks", () => {
    const timerRun: HarnessRun = { ...run, status: "waiting_timer", blocks: [{ blockId: "agent", status: "waiting_timer" }] };
    const callbacks = props();
    const view = render(<WorkflowRunPanel {...callbacks} runs={[timerRun]} onResumePause={vi.fn()} onCancelPause={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    const strip = screen.getByRole("region", { name: "Inspect timer pause" });
    expect(strip.textContent).toContain("Waiting");
    for (const button of within(strip).getAllByRole("button")) expect(button.hasAttribute("disabled")).toBe(true);
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...timerRun, blocks: [{ ...timerRun.blocks[0]!, pauseId: "pause" }] }]} />);
    for (const button of within(strip).getAllByRole("button")) expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("preserves question and retry pause presentations in the Workflows panel", () => {
    const callbacks = props();
    const view = render(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "awaiting_user_input", blocks: [{ blockId: "agent", status: "awaiting_user_input", question: "Which branch?" }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByRole("region", { name: "Inspect question" }).classList.contains("workflow-user-request")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Answer Inspect" })).toBeTruthy();
    view.rerender(<WorkflowRunPanel {...callbacks} runs={[{ ...run, status: "retry_scheduled", blocks: [{ blockId: "agent", status: "retry_scheduled", error: "Try again", retryAt: "2099-01-01T12:30:00.000Z" }] }]} />);
    expect(screen.getByRole("region", { name: "Inspect retry pause" }).classList.contains("harness-pause")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
    expect(document.querySelector(".workflow-timer-strip")).toBeNull();
  });

  it("sends custom input to the chosen start", async () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.change(screen.getByLabelText("Input for Custom goal"), { target: { value: "Review tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Custom goal" }));
    await waitFor(() => expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Review tests", "input", undefined));
  });

  it("keeps failed validation on the launch card", async () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} onValidate={vi.fn().mockResolvedValue({ valid: false, issues: [{ code: "empty", message: "Fix the workflow" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Quick check" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Fix the workflow");
    expect(callbacks.onRun).not.toHaveBeenCalled();
  });

  it("shows frozen run blocks, live transfers, and stops the selected active run", async () => {
    const callbacks = props();
    const snapshot = { ...workflow, blocks: workflow.blocks.map((block) => block.id === "agent" ? { ...block, label: "Original agent" } : block) };
    render(<WorkflowRunPanel {...callbacks} runs={[{ ...run, definition: snapshot, connectionTraces: [{ id: "trace", edgeId: "edge", direction: "forward", status: "active", startedAt: "now" }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByRole("button", { name: "Original agent: running" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".harness-transfer.active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Stop run run" }));
    await waitFor(() => expect(callbacks.onCancelRun).toHaveBeenCalledWith("run"));
  });

  it("provides a generic launch input for workflows without start blocks", async () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} harnesses={[{ ...workflow, blocks: [workflow.blocks[2]!] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.change(screen.getByLabelText("Input for Run workflow"), { target: { value: "Plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Run workflow" }));
    await waitFor(() => expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Plan", undefined, undefined));
  });

  it("formats block conversations and keeps runtime context and diagnostics expandable", () => {
    const prompt = "# Review plan\n\n- Check tests\n- Check `types`\n\nConnected tools: []";
    const answer = "## Result\n\n**All checks passed**\n\n```ts\nconst ready = true;\n```";
    render(<WorkflowRunPanel {...props()} runs={[{ ...run, blocks: [{ blockId: "agent", status: "succeeded", prompt, output: answer }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect: succeeded" }));
    const details = screen.getByLabelText("Inspect run details");
    expect(within(details).getByRole("heading", { name: "Review plan" })).toBeTruthy();
    expect(within(details).getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(details.querySelector(".workflow-message-markdown code")?.textContent).toBe("types");
    expect(details.querySelector(".harness-detail-diagnostics")?.hasAttribute("open")).toBe(false);
    expect(details.querySelector(".workflow-runtime-context")?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("button", { name: "Inspect: succeeded" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(details).getByRole("button", { name: "Show raw prompt" }));
    expect(details.querySelector(".workflow-message-raw")?.textContent).toBe(prompt);
    fireEvent.click(within(details).getByRole("button", { name: "Close run details" }));
    expect(screen.queryByLabelText("Inspect run details")).toBeNull();
  });

  it("previews the start prompt without launching when its raw view is toggled", () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    expect(screen.getByLabelText("Prompt").textContent).toContain("Check workspace");
    fireEvent.click(screen.getByRole("button", { name: "Show raw prompt" }));
    expect(document.querySelector(".workflow-message-raw")?.textContent).toBe("Check workspace");
    expect(callbacks.onRun).not.toHaveBeenCalled();
  });

  it("locks Workflow design to editing and hides launch controls", () => {
    render(<HarnessPanel {...props()} designOnly providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByLabelText("Workflow name")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Workflow mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByLabelText("Workflow input")).toBeNull();
  });
});


describe("workflow chat links", () => {
  const chat = { id: "chat", type: "chatbox" as const, label: "Assistant", prompt: "", position: { x: 0, y: 0 } };
  const renderChat = (text: string) => render(<BlockRunDetails block={chat} onClose={vi.fn()} state={{ blockId: "chat", status: "succeeded", chatMessages: [{ id: "reply", role: "assistant", text, timestamp: "now" }] }} />);

  it("sends to an idle Chatbox in a busy run and disables only its own active turn", async () => {
    const idle = { blockId: "chat", status: "succeeded" as const, chatMessages: [{ id: "old", role: "assistant" as const, text: "Previous reply", timestamp: "now" }] };
    const activeRun: HarnessRun = { ...run, status: "running", blocks: [{ blockId: "other", status: "running" }, idle] };
    let release!: () => void;
    const onChat = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const view = render(<BlockRunDetails block={chat} run={activeRun} state={idle} onClose={vi.fn()} onChat={onChat} />);
    expect(screen.getByText("Previous reply")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "Independent input" } });
    expect((screen.getByRole("button", { name: "Send chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send chat message" }));
    fireEvent.submit(screen.getByLabelText("Message Assistant").closest("form")!);
    expect(onChat).toHaveBeenCalledTimes(1); expect(onChat).toHaveBeenCalledWith("Independent input");
    release(); await waitFor(() => expect((screen.getByLabelText("Message Assistant") as HTMLTextAreaElement).value).toBe(""));
    view.rerender(<BlockRunDetails block={chat} run={activeRun} state={{ ...idle, status: "running" }} onClose={vi.fn()} onChat={onChat} />);
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "Duplicate" } });
    expect((screen.getByRole("button", { name: "Steer chat response" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Message Assistant").closest("form")!);
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("shows live provider activity, connected app calls and their results", () => {
    const timestamp = "2026-10-08T12:00:00Z";
    const state: HarnessRun["blocks"][number] = { blockId: "chat", status: "running", startedAt: timestamp, agentActivity: [{ id: "tool", timestamp, text: "Running npm test\nTest output" }] };
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [chat, { id: "app", type: "run_app", label: "Server", prompt: "", app: { name: "server", actions: ["status", "tail"] }, position: { x: 0, y: 0 } }], edges: [] };
    const activeRun: HarnessRun = { ...run, definition: appWorkflow, blocks: [state] };
    const view = render(<BlockRunDetails block={chat} run={activeRun} state={state} onClose={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Agent current activity" }).textContent).toBe("Running npm test");
    const operation = { id: "call", idempotencyKey: "call", kind: "tool_command" as const, blockId: "chat", status: "intent" as const, createdAt: timestamp, updatedAt: timestamp, input: { name: "workflow_use_block", args: { block_id: "app", action: "tail", lines: 20 } } };
    view.rerender(<BlockRunDetails block={chat} run={{ ...activeRun, operations: [operation] }} state={state} onClose={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Agent current activity" }).textContent).toBe("Running Server · tail · 20 lines");
    fireEvent.click(screen.getByRole("status", { name: "Agent current activity" }));
    expect(screen.getByText("Server · tail · 20 lines")).toBeTruthy();
    view.rerender(<BlockRunDetails block={chat} run={{ ...activeRun, status: "succeeded", operations: [{ ...operation, status: "succeeded", result: { app: { status: "running", output: "ready" } } }] }} state={{ ...state, status: "succeeded" }} onClose={vi.fn()} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    fireEvent.click(screen.getByText("Server · tail · 20 lines"));
    expect(screen.getByText(/"output": "ready"/)).toBeTruthy();
  });

  it("opens Markdown links and bare URLs externally without navigating the workflow UI", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("desktop", { openExternal });
    renderChat("[Preview](http://localhost:3000/page?foo=bar#result) https://example.com/docs");
    const preview = screen.getByRole("link", { name: "Preview" });
    expect(fireEvent.click(preview)).toBe(false);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("http://localhost:3000/page?foo=bar#result"));
    expect(preview.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("link", { name: "https://example.com/docs" }));
    await waitFor(() => expect(openExternal).toHaveBeenLastCalledWith("https://example.com/docs"));
    const middleClick = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    fireEvent(preview, middleClick);
    expect(middleClick.defaultPrevented).toBe(true);
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Message Assistant")).toBeTruthy();
  });

  it("keeps malformed, unsafe and relative links from replacing the UI", () => {
    const openExternal = vi.fn();
    vi.stubGlobal("desktop", { openExternal });
    renderChat("[Bad](http://[broken) [Unsafe](javascript:alert) [Relative](docs/readme.md) [File](file:///tmp/test.md)");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("Bad")).toBeTruthy();
    expect(screen.getByText("Unsafe")).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message Assistant")).toBeTruthy();
  });

  it("handles external opening failures without crashing the chat", async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error("Browser could not open link"));
    vi.stubGlobal("desktop", { openExternal });
    renderChat("[Docs](https://example.com/docs)");
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Browser could not open link");
    expect(screen.getByLabelText("Message Assistant")).toBeTruthy();
  });
});
