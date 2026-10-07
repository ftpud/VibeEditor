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
  it("offers every start and replaces launch controls with a live preview after starting", async () => {
    const callbacks = props();
    const view = render(<WorkflowRunPanel {...callbacks} />);
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
    fireEvent.change(screen.getByLabelText("Input for Custom goal"), { target: { value: "Review tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Custom goal" }));
    await waitFor(() => expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Review tests", "input", undefined));
  });

  it("keeps failed validation on the launch card", async () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} onValidate={vi.fn().mockResolvedValue({ valid: false, issues: [{ code: "empty", message: "Fix the workflow" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Quick check" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Fix the workflow");
    expect(callbacks.onRun).not.toHaveBeenCalled();
  });

  it("shows frozen run blocks, live transfers, and stops the selected active run", async () => {
    const callbacks = props();
    const snapshot = { ...workflow, blocks: workflow.blocks.map((block) => block.id === "agent" ? { ...block, label: "Original agent" } : block) };
    render(<WorkflowRunPanel {...callbacks} runs={[{ ...run, definition: snapshot, connectionTraces: [{ id: "trace", edgeId: "edge", direction: "forward", status: "active", startedAt: "now" }] }]} />);
    expect(screen.getByRole("button", { name: "Original agent: running" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".harness-transfer.active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Stop run run" }));
    await waitFor(() => expect(callbacks.onCancelRun).toHaveBeenCalledWith("run"));
  });

  it("provides a generic launch input for workflows without start blocks", async () => {
    const callbacks = props();
    render(<WorkflowRunPanel {...callbacks} harnesses={[{ ...workflow, blocks: [workflow.blocks[2]!] }]} />);
    fireEvent.change(screen.getByLabelText("Input for Run workflow"), { target: { value: "Plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Run workflow" }));
    await waitFor(() => expect(callbacks.onRun).toHaveBeenCalledWith("flow", "Plan", undefined, undefined));
  });

  it("formats block conversations and keeps runtime context and diagnostics expandable", () => {
    const prompt = "# Review plan\n\n- Check tests\n- Check `types`\n\nConnected tools: []";
    const answer = "## Result\n\n**All checks passed**\n\n```ts\nconst ready = true;\n```";
    render(<WorkflowRunPanel {...props()} runs={[{ ...run, blocks: [{ blockId: "agent", status: "succeeded", prompt, output: answer }] }]} />);
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
