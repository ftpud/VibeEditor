import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDefinition } from "@remote-ide/protocol";
import { dragPosition, edgePath, HarnessPanel, responsePreview } from "./HarnessPanel";

afterEach(cleanup);

describe("HarnessPanel", () => {
  it("creates a workflow from the in-panel name form", async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: "harness-1", name: "Review flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] });
    render(<HarnessPanel harnesses={[]} runs={[]} providers={[]} agents={[]} onCreate={onCreate} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByText("Create workflow", { selector: "button" }));
    const name = screen.getByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Review flow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Review flow"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull());
  });

  it("connects output to input and renders a directional edge", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "prompt", label: "Plan", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "prompt", label: "Build", prompt: "", position: { x: 260, y: 150 } },
    ], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    await screen.findByRole("button", { name: "Connect from Plan" });

    fireEvent.click(screen.getByRole("button", { name: "Connect from Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect into Build" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls.at(0)?.[0].edges).toMatchObject([{ from: "a", to: "b" }]);
    const edge = screen.getByLabelText("Workflow connections").querySelector(".harness-edge");
    expect(edge?.getAttribute("marker-end")).toContain("harness-arrow");
    expect(edge?.textContent).toContain("Plan then Build");
  });

  it("turns a backward connection into a visible loop edge", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Cycle", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "task", label: "Build", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "prompt", label: "Review", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [{ id: "forward", from: "a", to: "b", label: "review" }] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect from Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect into Build" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges[1]).toMatchObject({ from: "b", to: "a", loop: true }));
    expect(screen.getByLabelText("Workflow connections").querySelector(".harness-edge.loop")?.textContent).toContain("Review loops to Build");
  });

  it("selects and deletes an individual connection", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "prompt", label: "Plan", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "prompt", label: "Build", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [{ id: "edge", from: "a", to: "b" }] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select connection: Plan then Build" }));
    expect(screen.getByText(/Selected connection:/).textContent).toContain("Plan → Build");
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges).toEqual([]));
  });

  it("changes a selected connection from sync to async", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "prompt", label: "Plan", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "task", label: "Build", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [{ id: "edge", from: "a", to: "b" }] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select connection: Plan then Build" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Connection execution" }), { target: { value: "async" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges[0].execution).toBe("async"));
  });

  it("routes vertical connections from the block edges", () => {
    const block = (id: string, x: number, y: number) => ({ id, type: "prompt" as const, label: id, prompt: "", position: { x, y } });
    expect(edgePath(block("a", 20, 20), block("b", 30, 220))).toMatch(/^M 108 136 C /);
  });

  it("keeps dragged blocks under the pointer in a scrolled canvas", () => {
    expect(dragPosition(450, 380, 100, 80, 40, 60, 30, 20)).toEqual({ x: 360, y: 340 });
  });

  it("shows a compact preview of each block response", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded" as const, createdAt: "now", blocks: [{ blockId: "a", status: "succeeded" as const, output: "First line\n\nSecond line" }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    expect((await screen.findByLabelText("Plan response preview")).textContent).toBe("First line Second line");
    expect(responsePreview("x".repeat(150))).toHaveLength(140);
  });

  it("selects a block model from the provider catalogue", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    const onLoadModels = vi.fn().mockResolvedValue([{ id: "gpt-test", name: "GPT Test", defaultReasoning: "medium", reasoningLevels: ["medium"] }]);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} defaultProvider="codex" onLoadModels={onLoadModels} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByText("Plan"));
    fireEvent.click(await screen.findByRole("button", { name: "AI model" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT Test/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].blocks[0].model).toBe("gpt-test"));
  });

  it("shows prompts, answers, and stack runs when a block is selected in view mode", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded" as const, createdAt: "now", blocks: [{ blockId: "a", status: "succeeded" as const, prompt: "Review task", output: "combined", plannedRuns: 2, iterations: [{ index: 1, status: "succeeded" as const, startedAt: "now", prompt: "Review task 1", output: "answer one" }, { index: 2, status: "succeeded" as const, startedAt: "now", prompt: "Review task 2", output: "answer two" }] }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByText("Review"));

    const details = await screen.findByLabelText("Review run details");
    expect(details.querySelector(".harness-run-details-body")).not.toBeNull();
    expect(details.textContent).toContain("Stack items (2/2)");
    expect(details.textContent).toContain("Review task 2");
    expect(details.textContent).toContain("answer two");
  });

  it("keeps the execution log collapsed until requested", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded" as const, createdAt: "now", blocks: [{ blockId: "a", status: "succeeded" as const, output: "answer", log: [{ timestamp: "2026-09-18T00:00:00Z", kind: "lifecycle" as const, message: "Started" }] }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByText("Review"));
    const log = (await screen.findByText("Execution log (1)")).closest("details");
    expect(log?.open).toBe(false);
    fireEvent.click(screen.getByText("Execution log (1)"));
    expect(log?.open).toBe(true);
  });

  it("shows validation issues and blocks an invalid save", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "", position: { x: 20, y: 20 } }], edges: [] };
    const onValidate = vi.fn().mockResolvedValue({ valid: false, issues: [{ code: "empty-prompt", blockId: "a", message: "Plan needs a prompt" }] });
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onValidate={onValidate} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Workflow name"), { target: { value: "Changed" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Plan needs a prompt");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
