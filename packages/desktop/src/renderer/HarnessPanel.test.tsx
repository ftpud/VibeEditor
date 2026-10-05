import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
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

  it.each([["five-minute-check-in", "Five-minute workspace check-in"], ["git-review-commit", "Review, commit & ask to push"]])("creates the %s template from the creation form", async (template, name) => {
    const onCreate = vi.fn().mockResolvedValue({ id: "flow", name: "Check-ins", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] });
    render(<HarnessPanel harnesses={[]} runs={[]} providers={[]} agents={[]} onCreate={onCreate} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByText("Create workflow", { selector: "button" }));
    fireEvent.change(screen.getByLabelText("Workflow template"), { target: { value: template } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(name, template));
  });

  it("shows persisted workflow-state recovery diagnostics", () => {
    render(<HarnessPanel harnesses={[]} runs={[]} diagnostics={[{ source: "runs.json", reason: "Unexpected end of JSON input", detectedAt: "now" }]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("Workflow state recovered from backup");
    expect(screen.getByRole("alert").textContent).toContain("runs.json: Unexpected end of JSON input");
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

  it("connects an AI to another AI as a tool", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Cycle", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "ai", label: "Build", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "ai", label: "Review", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [{ id: "forward", from: "a", to: "b", label: "review" }] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect from Review" }));
    fireEvent.change(screen.getByLabelText("New connection type"), { target: { value: "use" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect into Build" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges[1]).toMatchObject({ from: "b", to: "a", type: "use" }));
    expect(screen.getByLabelText("Workflow connections").querySelector(".harness-edge.use")?.textContent).toContain("Review then Build");
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

  it("changes a selected connection from follow to path", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "ai", label: "Plan", prompt: "", position: { x: 20, y: 20 } },
      { id: "b", type: "task", label: "Build", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [{ id: "edge", from: "a", to: "b" }] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select connection: Plan then Build" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Connection type" }), { target: { value: "path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges[0].type).toBe("path"));
  });

  it("starts both entry types from their canvas controls in View mode", async () => {
    const harness: HarnessDefinition = { id: "flow", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "button", type: "start_button", label: "Button start", prompt: "Configured prompt", position: { x: 20, y: 20 } },
      { id: "input", type: "start_input", label: "Text start", prompt: "", position: { x: 250, y: 20 } }
    ], edges: [] };
    const onRun = vi.fn().mockResolvedValue({ id: "run" });
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={onRun} onCancelRun={vi.fn()} onError={vi.fn()} />);
    await screen.findByLabelText("Workflow name"); fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByLabelText("Workflow input")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Start" })[0]!);
    await waitFor(() => expect(onRun).toHaveBeenCalledWith("flow", "Configured prompt", "button"));
    fireEvent.change(screen.getByLabelText("Input for Text start"), { target: { value: "Typed prompt" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Start" })[1]!);
    await waitFor(() => expect(onRun).toHaveBeenCalledWith("flow", "Typed prompt", "input"));
    fireEvent.click(screen.getByText("Button start")); expect(screen.queryByLabelText("Block type")).toBeNull();
  });

  it("adds a timer with type-specific settings", async () => {
    const harness: HarnessDefinition = { id: "flow", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Add block type"), { target: { value: "timer" } });
    expect((screen.getByLabelText("Block type") as HTMLSelectElement).value).toBe("timer");
    expect(screen.queryByLabelText("Block role")).toBeNull();
    fireEvent.change(screen.getByLabelText("Timer seconds"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls[0]?.[0].blocks[0]).toMatchObject({ type: "timer", seconds: 5 }));
  });

  it("animates real forward and return transfers, pulses ports, and clears finished traces", async () => {
    vi.useFakeTimers();
    try {
      const harness: HarnessDefinition = { id: "flow", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
        { id: "agent", type: "ai", label: "Agent", prompt: "Work", position: { x: 20, y: 20 } },
        { id: "tool", type: "text", label: "Tool", prompt: "Text", position: { x: 250, y: 20 } },
        { id: "unused", type: "text", label: "Unused", prompt: "Text", position: { x: 500, y: 20 } }
      ], edges: [{ id: "use", from: "agent", to: "tool", type: "use" }, { id: "unused-path", from: "agent", to: "unused", type: "path", label: "unused" }] };
      const run: HarnessRun = { id: "run", harnessId: "flow", harnessVersion: 1, input: "work", status: "running", createdAt: "now", blocks: [{ blockId: "agent", status: "running" }], connectionTraces: [] };
      const props = { harnesses: [harness], providers: [], agents: [], onCreate: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(), onRun: vi.fn(), onCancelRun: vi.fn(), onError: vi.fn() };
      const view = render(<HarnessPanel {...props} runs={[run]} />);
      view.rerender(<HarnessPanel {...props} runs={[{ ...run, connectionTraces: [{ id: "request", edgeId: "use", direction: "forward", status: "succeeded", startedAt: "now" }, { id: "reply", edgeId: "use", direction: "return", status: "succeeded", startedAt: "now" }] }]} />);
      expect(screen.getByLabelText("Input: Agent → Tool").classList.contains("forward")).toBe(true);
      expect(screen.getByLabelText("Output: Tool → Agent").classList.contains("return")).toBe(true);
      expect(screen.queryByLabelText("Input: Agent → Unused")).toBeNull();
      expect(screen.getByLabelText("Connect into Tool").classList.contains("flowing")).toBe(true);
      expect(screen.getByLabelText("Connect from Agent").classList.contains("flowing")).toBe(true);
      await act(async () => { vi.advanceTimersByTime(2500); });
      expect(screen.queryByLabelText("Input: Agent → Tool")).toBeNull();
      expect(screen.queryByLabelText("Output: Tool → Agent")).toBeNull();
      expect(screen.getByLabelText("Connect into Tool").classList.contains("flowing")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("clears active traces when a run is cancelled and does not replay historical traces", () => {
    const harness: HarnessDefinition = { id: "flow", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "a", type: "ai", label: "Agent", prompt: "Work", position: { x: 20, y: 20 } },
      { id: "b", type: "text", label: "Tool", prompt: "Text", position: { x: 250, y: 20 } }
    ], edges: [{ id: "use", from: "a", to: "b", type: "use" }] };
    const run: HarnessRun = { id: "run", harnessId: "flow", harnessVersion: 1, input: "work", status: "running", createdAt: "now", blocks: [], connectionTraces: [{ id: "request", edgeId: "use", direction: "forward", status: "active", startedAt: "now" }] };
    const props = { harnesses: [harness], providers: [], agents: [], onCreate: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(), onRun: vi.fn(), onCancelRun: vi.fn(), onError: vi.fn() };
    const view = render(<HarnessPanel {...props} runs={[run]} />);
    expect(screen.getByLabelText("Input: Agent → Tool")).toBeTruthy();
    view.rerender(<HarnessPanel {...props} runs={[{ ...run, status: "cancelled" }]} />);
    expect(screen.queryByLabelText("Input: Agent → Tool")).toBeNull();
    view.rerender(<HarnessPanel {...props} runs={[{ ...run, id: "historical", status: "succeeded", connectionTraces: [{ ...run.connectionTraces![0]!, status: "succeeded" }] }]} />);
    expect(screen.queryByLabelText("Input: Agent → Tool")).toBeNull();
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

  it("saves declared JSON schemas and shows the validated run data", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: '{"featureId":"F-1"}', status: "succeeded" as const, createdAt: "now", blocks: [{ blockId: "a", status: "succeeded" as const, structuredInput: { featureId: "F-1" }, structuredOutput: { commitSha: "abc123" } }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByText("Plan"));
    fireEvent.change(screen.getByRole("textbox", { name: "Input schema" }), { target: { value: '{"type":"object","required":["featureId"],"properties":{"featureId":{"type":"string"}}}' } });
    fireEvent.change(screen.getByRole("textbox", { name: "Output schema" }), { target: { value: '{"type":"object","required":["commitSha"],"properties":{"commitSha":{"type":"string"}}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].blocks[0]).toMatchObject({ inputSchema: { required: ["featureId"] }, outputSchema: { required: ["commitSha"] } }));

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const details = await screen.findByLabelText("Plan run details");
    expect(details.textContent).toContain("Validated input");
    expect(details.textContent).toContain("featureId");
    expect(details.textContent).toContain("commitSha");
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

  it("validates again immediately before saving", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const invalid = { valid: false, issues: [{ code: "empty-prompt" as const, blockId: "a", message: "Plan needs a prompt" }] };
    const onValidate = vi.fn().mockResolvedValue(invalid);
    const onSave = vi.fn();
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onValidate={onValidate} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Workflow name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onValidate).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps an unsaved draft when switching workflows or modes is declined", async () => {
    const harnesses: HarnessDefinition[] = [
      { id: "harness-1", name: "First", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] },
      { id: "harness-2", name: "Second", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] },
    ];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HarnessPanel harnesses={harnesses} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Workflow name"), { target: { value: "Changed" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Selected workflow" }), { target: { value: "harness-2" } });
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Changed");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("button", { name: "Edit" }).className).toContain("active");
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("offers reload, comparison, and save-as-copy when a concurrent save conflicts", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] };
    const remote = { ...harness, name: "Remote change", version: 2 };
    const onCreate = vi.fn().mockResolvedValue({ ...harness, id: "copy", name: "Local change copy" });
    const onSave = vi.fn().mockRejectedValueOnce(new Error("CONFLICT: Workflow changed since it was opened")).mockRejectedValueOnce(new Error("CONFLICT: Workflow changed since it was opened")).mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={onCreate} onRead={vi.fn().mockResolvedValue(remote)} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Workflow name"), { target: { value: "Local change" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByText("Your draft")).toBeTruthy();
    expect(screen.getByText("Saved workflow")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Remote change");
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Local change" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Save as copy" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Local change copy"));
  });

  it("blocks unavailable provider settings and previews execution inputs", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "Plan {{input}} then use {{blocks.build.output}}", provider: "missing", position: { x: 20, y: 20 } }], edges: [] };
    const provider = { id: "codex", name: "Codex", description: "", settings: { title: "", description: "", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true } };
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[provider]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("unavailable provider 'missing'");
    fireEvent.click(screen.getByText("Plan"));
    expect(screen.getByLabelText("Rendered prompt preview").textContent).toBe("Plan [workflow input] then use [output from build]");
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Changed" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("selects historical runs and pins active runs first", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [
      { id: "old", harnessId: harness.id, harnessVersion: 1, input: "old input", status: "succeeded" as const, createdAt: "2026-01-01T00:00:00Z", blocks: [{ blockId: "a", status: "succeeded" as const, output: "old answer" }] },
      { id: "active", harnessId: harness.id, harnessVersion: 1, input: "new input", status: "running" as const, createdAt: "2026-01-02T00:00:00Z", blocks: [{ blockId: "a", status: "running" as const, output: "new answer" }] }
    ];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const selector = await screen.findByRole("combobox", { name: "Selected workflow run" });
    expect((selector.querySelector("option") as HTMLOptionElement).value).toBe("active");
    fireEvent.change(selector, { target: { value: "old" } }); fireEvent.click(await screen.findByText("Plan"));
    expect((await screen.findByLabelText("Plan run details")).textContent).toContain("old answer");
  });

  it("shows and resolves a workflow-owned permission request", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Deploy", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const permission = { id: "permission-1", title: "Run deployment", toolCallId: "tool-1", options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" as const }] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "deploy", status: "awaiting_permission" as const, createdAt: "now", blocks: [{ blockId: "a", status: "awaiting_permission" as const, provider: "codex", workspace: "/workflow/a", sessionId: "session-1", pauseId: "pause-1", pendingPermission: permission }] }];
    const onResolvePermission = vi.fn().mockResolvedValue(runs[0]);
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onResolvePermission={onResolvePermission} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(onResolvePermission).toHaveBeenCalledWith("run-1", "a", "session-1", "pause-1", "permission-1", "yes"));
  });

  it.each(["Yes", "No"])("submits %s from a Yes/No prompt without a text input", async (choice) => {
    const harness: HarnessDefinition = { id: "confirm-flow", name: "Confirm", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "confirm", type: "yes_no_prompt", label: "Approve push", prompt: "Push?", position: { x: 20, y: 20 } }], edges: [] };
    const runs: HarnessRun[] = [{ id: "confirm-run", harnessId: harness.id, harnessVersion: 1, input: "", status: "awaiting_user_input", createdAt: "now", blocks: [{ blockId: "confirm", status: "awaiting_user_input", sessionId: "flow:confirm", pauseId: "pause", question: "Push?" }] }];
    const onAnswerQuestion = vi.fn().mockResolvedValue(runs[0]);
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onAnswerQuestion={onAnswerQuestion} onError={vi.fn()} />);
    expect(screen.getByText("Yes/No Prompt", { selector: "small" })).toBeTruthy();
    expect(screen.queryByText("Default model")).toBeNull();
    expect(screen.queryByLabelText("Answer Approve push")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: choice }));
    await waitFor(() => expect(onAnswerQuestion).toHaveBeenCalledWith("confirm-run", "confirm", "flow:confirm", "pause", choice.toLowerCase()));
  });

  it("shows a provider question and submits the answer to its owning attempt", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Planner", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "plan", status: "awaiting_user_input" as const, createdAt: "now", blocks: [{ blockId: "a", status: "awaiting_user_input" as const, provider: "codex", workspace: "/workflow/a", sessionId: "session-2", pauseId: "pause-2", question: "Which branch?" }] }];
    const onAnswerQuestion = vi.fn().mockResolvedValue(runs[0]);
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onAnswerQuestion={onAnswerQuestion} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Answer Planner" }), { target: { value: "feature/auth" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer and resume" }));
    await waitFor(() => expect(onAnswerQuestion).toHaveBeenCalledWith("run-1", "a", "session-2", "pause-2", "feature/auth"));
  });

  it("resumes a timer pause and can cancel its exact attempt", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Worker", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "work", status: "waiting_timer" as const, createdAt: "now", blocks: [{ blockId: "a", status: "waiting_timer" as const, provider: "codex", workspace: "/workflow/a", sessionId: "session-3", pauseId: "pause-3", waitingUntil: "2099-01-01T00:00:00.000Z" }] }];
    const onResumePause = vi.fn().mockResolvedValue(runs[0]); const onCancelPause = vi.fn().mockResolvedValue(runs[0]);
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onResumePause={onResumePause} onCancelPause={onCancelPause} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(onResumePause).toHaveBeenCalledWith("run-1", "a", "pause-3"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(onCancelPause).toHaveBeenCalledWith("run-1", "a", "pause-3"));
  });

  it("retries a scheduled attempt immediately", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Worker", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "work", status: "retry_scheduled" as const, createdAt: "now", blocks: [{ blockId: "a", status: "retry_scheduled" as const, provider: "codex", pauseId: "pause-4", error: "Transport failed", retryAt: "2099-01-01T00:00:00.000Z" }] }];
    const onRetryPause = vi.fn().mockResolvedValue(runs[0]);
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onRetryPause={onRetryPause} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(onRetryPause).toHaveBeenCalledWith("run-1", "a", "pause-4"));
  });
});
