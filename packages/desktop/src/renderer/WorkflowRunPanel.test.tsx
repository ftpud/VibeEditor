import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("fits each axis and kills an app from a completed run", async () => {
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "app", type: "run_app", label: "Server", prompt: "", command: "npm run dev", app: { name: "server", actions: ["start"] }, position: { x: 0, y: 0 } }] };
    const appRun: HarnessRun = { ...run, status: "succeeded", definition: appWorkflow, blocks: [{ blockId: "app", status: "succeeded" }] };
    const onReadApp = vi.fn().mockResolvedValue({ name: "server", status: "running", output: "Listening on port 3000\nerror stream", pid: 123 });
    const onKillApp = vi.fn(async () => { onReadApp.mockResolvedValue({ name: "server", status: "exited", output: "Listening on port 3000\nerror stream", pid: 123, signal: "SIGKILL" }); });
    render(<WorkflowRunPanel {...props()} harnesses={[appWorkflow]} runs={[appRun]} onKillApp={onKillApp} onReadApp={onReadApp} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    const preview = screen.getByLabelText("Live workflow tree");
    Object.defineProperties(preview, { clientWidth: { value: 400 }, clientHeight: { value: 220 } });
    fireEvent.click(screen.getByRole("button", { name: "Fit workflow horizontally" }));
    expect(Number(preview.querySelector("svg")!.getAttribute("width"))).toBe(392);
    fireEvent.click(screen.getByRole("button", { name: "Fit workflow vertically" }));
    expect(Number(preview.querySelector("svg")!.getAttribute("height"))).toBe(212);
    fireEvent.click(screen.getByRole("button", { name: "Server: succeeded" }));
    expect(await screen.findByText(/Listening on port 3000/)).toBeTruthy();
    expect(onReadApp).toHaveBeenCalledWith("flow", "app", "run");
    const kill = screen.getByRole("button", { name: "Kill process" });
    expect(kill.closest("header")).toBeTruthy();
    expect(kill.textContent).toBe("");
    fireEvent.click(kill);
    await waitFor(() => expect(onKillApp).toHaveBeenCalledWith("flow", "app", "run"));
    expect(await screen.findByText("Exited · SIGKILL")).toBeTruthy();
  });

  it("refreshes app output while details are open", async () => {
    const appWorkflow: HarnessDefinition = { ...workflow, blocks: [{ id: "app", type: "run_app", label: "Server", prompt: "", app: { name: "server", actions: ["start"] }, position: { x: 0, y: 0 } }], edges: [] };
    const onReadApp = vi.fn().mockResolvedValueOnce({ name: "server", status: "running", output: "first line" }).mockResolvedValue({ name: "server", status: "running", output: "first line\nsecond line" });
    render(<WorkflowRunPanel {...props()} harnesses={[appWorkflow]} onReadApp={onReadApp} />);
    fireEvent.click(screen.getByRole("button", { name: "Show Workspace check" }));
    fireEvent.click(screen.getByRole("button", { name: "Server: idle" }));
    expect(await screen.findByText("first line")).toBeTruthy();
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
