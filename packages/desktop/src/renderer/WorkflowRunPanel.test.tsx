import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { HarnessPanel } from "./HarnessPanel";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

afterEach(cleanup);
const workflow: HarnessDefinition = { id: "flow", name: "Workspace check", version: 1, createdAt: "now", updatedAt: "now", blocks: [
  { id: "button", type: "start_button", label: "Quick check", prompt: "Check workspace", position: { x: 0, y: 0 } },
  { id: "input", type: "start_input", label: "Custom goal", prompt: "", position: { x: 0, y: 100 } },
  { id: "agent", type: "ai", label: "Inspect", prompt: "{{input}}", position: { x: 300, y: 0 } },
], edges: [{ id: "edge", from: "button", to: "agent" }] };
const run: HarnessRun = { id: "run", harnessId: workflow.id, harnessVersion: 1, definition: workflow, input: "Check workspace", status: "running", createdAt: "2026-10-07T12:00:00Z", blocks: [{ blockId: "button", status: "succeeded" }, { blockId: "agent", status: "running" }] };
const props = () => ({ harnesses: [workflow], runs: [], onRun: vi.fn().mockResolvedValue(run), onCancelRun: vi.fn().mockResolvedValue(undefined), onError: vi.fn() });

describe("Workflow run library", () => {
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
