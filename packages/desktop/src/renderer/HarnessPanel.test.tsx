import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessBlock, HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { alignBlocks, autoLayoutBlocks, dragPosition, edgePath, fitCanvasViewport, HarnessPanel, minimapScrollPosition, minimapViewport, responsePreview, workflowRunExport } from "./HarnessPanel";

afterEach(cleanup);

describe("HarnessPanel", () => {
  it("serializes a selected workflow run for export", () => {
    const run: HarnessRun = { id: "run-1", harnessId: "flow", harnessVersion: 1, input: "work", status: "succeeded", createdAt: "now", blocks: [] };
    expect(JSON.parse(workflowRunExport(run))).toEqual(run);
  });
  const zoomHarness: HarnessDefinition = { id: "zoom", name: "Zoom flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
    { id: "a", type: "text", label: "First", prompt: "", position: { x: 200, y: 200 } },
    { id: "b", type: "text", label: "Second", prompt: "", position: { x: 500, y: 200 } },
  ], edges: [{ id: "edge", from: "a", to: "b" }] };
  function renderZoomHarness() {
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[zoomHarness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    const canvas = screen.getByLabelText("Workflow canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 100, top: 80 } as DOMRect);
    Object.defineProperties(canvas, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    canvas.scrollLeft = 300; canvas.scrollTop = 200;
    return { canvas, onSave };
  }

  it.each([{ ctrlKey: true, deltaY: -80 }, { shiftKey: true, deltaY: -80 }, { shiftKey: true, deltaX: -80 }])("anchors modified wheel zoom and prevents page zoom: %j", (gesture) => {
    const { canvas } = renderZoomHarness();
    const event = new WheelEvent("wheel", { ...gesture, clientX: 300, clientY: 180, bubbles: true, cancelable: true });
    // happy-dom's WheelEvent extends UIEvent and omits MouseEvent fields.
    Object.defineProperties(event, { ctrlKey: { value: "ctrlKey" in gesture }, shiftKey: { value: "shiftKey" in gesture }, clientX: { value: 300 }, clientY: { value: 180 } });
    act(() => { canvas.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    const scale = Math.exp(0.16);
    expect(canvas.scrollLeft).toBeCloseTo(500 * scale - 200);
    expect(canvas.scrollTop).toBeCloseTo(300 * scale - 100);
    expect(canvas.querySelector<HTMLElement>(".harness-canvas-content")?.style.transform).toBe(`scale(${scale})`);
    // Connections and blocks share the same transformed coordinate space.
    expect(screen.getByLabelText("Workflow connections").parentElement).toBe(canvas.querySelector(".harness-canvas-content"));
    expect(screen.getByLabelText("First response preview").closest(".harness-block")?.parentElement).toBe(canvas.querySelector(".harness-canvas-content"));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("preserves ordinary scrolling and supports bounded controls/reset in both modes", () => {
    const { canvas } = renderZoomHarness();
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    act(() => { canvas.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "Reset workflow zoom" }).textContent).toBe("100%");
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reset workflow zoom" }).textContent).toBe("200%");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reset workflow zoom" }).textContent).toBe("25%");
    fireEvent.click(screen.getByRole("button", { name: "Reset workflow zoom" }));
    expect(screen.getByRole("button", { name: "Reset workflow zoom" }).textContent).toBe("100%");
  });

  it("fits every workflow block into the canvas and centers the resulting viewport", () => {
    const { canvas } = renderZoomHarness();
    fireEvent.click(screen.getByRole("button", { name: "Fit workflow to canvas" }));
    const fitted = fitCanvasViewport(zoomHarness.blocks, 600, 400);
    expect(screen.getByRole("button", { name: "Reset workflow zoom" }).textContent).toBe(`${Math.round(fitted.zoom * 100)}%`);
    expect(canvas.scrollLeft).toBeCloseTo(fitted.scrollLeft);
    expect(canvas.scrollTop).toBeCloseTo(fitted.scrollTop);
  });

  it("persists the configured workflow concurrency", async () => {
    const { onSave } = renderZoomHarness();
    fireEvent.click(screen.getByText("Execution settings"));
    fireEvent.change(screen.getByLabelText("Workflow concurrency"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Workflow active run limit"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Workflow block attempt limit"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Workflow stack size limit"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Workflow loop limit"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Workflow child task limit"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Workflow prompt limit"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Workflow retry attempts"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Workflow output limit"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Workflow log limit"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Workflow run duration"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Workflow token budget"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].settings).toEqual({ concurrency: 2, maxActiveRuns: 3, maxBlockAttempts: 20, maxStackSize: 10, maxLoopCount: 5, maxChildTasks: 8, promptLimitChars: 5000, retry: { maxAttempts: 5 }, outputLimitChars: 5000, logLimitEntries: 25, maxRunDurationMs: 900_000, tokenBudget: 50_000 }));
  });

  it("shows the current canvas viewport in a minimap and moves it on click", () => {
    const { canvas } = renderZoomHarness();
    canvas.scrollLeft = 300; canvas.scrollTop = 200;
    fireEvent.scroll(canvas);
    const minimap = screen.getByRole("button", { name: "Workflow minimap" });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30, width: 150, height: 100 } as DOMRect);
    const viewport = minimapViewport(1200, 800, 1, { left: 300, top: 200, width: 600, height: 400 });
    const indicator = minimap.querySelector<HTMLElement>(".harness-minimap-viewport")!;
    expect(indicator.style.left).toBe(`${viewport.left}%`);
    expect(indicator.style.width).toBe(`${viewport.width}%`);
    fireEvent.click(minimap, { clientX: 95, clientY: 80, detail: 1 });
    expect(canvas.scrollLeft).toBeCloseTo(300);
    expect(canvas.scrollTop).toBeCloseTo(200);
  });

  it("clamps minimap navigation to the canvas edges", () => {
    expect(minimapScrollPosition(0, 0, 150, 100, 1200, 800, 1, 600, 400)).toEqual({ left: 0, top: 0 });
    expect(minimapScrollPosition(150, 100, 150, 100, 1200, 800, 1, 600, 400)).toEqual({ left: 600, top: 400 });
  });

  it("arranges connected blocks into stable workflow columns", () => {
    const blocks = [
      { id: "build", type: "text" as const, label: "Build", prompt: "", position: { x: 900, y: 400 } },
      { id: "plan", type: "text" as const, label: "Plan", prompt: "", position: { x: 500, y: 300 } },
      { id: "test", type: "text" as const, label: "Test", prompt: "", position: { x: 100, y: 200 } },
      { id: "notes", type: "text" as const, label: "Notes", prompt: "", position: { x: 20, y: 20 } },
    ];
    const edges = [{ id: "plan-build", from: "plan", to: "build" }, { id: "build-test", from: "build", to: "test" }, { id: "tool", from: "test", to: "plan", type: "use" as const }];
    expect(autoLayoutBlocks(blocks, edges).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "build", position: { x: 292, y: 32 } },
      { id: "plan", position: { x: 32, y: 32 } },
      { id: "test", position: { x: 552, y: 32 } },
      { id: "notes", position: { x: 32, y: 192 } },
    ]);
  });

  it("lays out the draft through the canvas control without saving it", () => {
    const { onSave } = renderZoomHarness();
    fireEvent.click(screen.getByRole("button", { name: "Automatically lay out workflow" }));
    const first = screen.getByLabelText("First response preview").closest(".harness-block") as HTMLElement;
    const second = screen.getByLabelText("Second response preview").closest(".harness-block") as HTMLElement;
    expect(first.style.left).toBe("32px");
    expect(second.style.left).toBe("292px");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("multi-selects blocks with a modifier and moves the selected group together", () => {
    const { canvas } = renderZoomHarness();
    const first = screen.getByLabelText("First response preview").closest(".harness-block") as HTMLElement;
    const second = screen.getByLabelText("Second response preview").closest(".harness-block") as HTMLElement;
    first.setPointerCapture = vi.fn(); second.setPointerCapture = vi.fn();
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue({ left: 0, top: 80 } as DOMRect);
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue({ left: 300, top: 80 } as DOMRect);
    fireEvent.pointerDown(first, { pointerId: 1, button: 0, clientX: 0, clientY: 80 });
    fireEvent.pointerDown(second, { pointerId: 2, button: 0, ctrlKey: true, clientX: 330, clientY: 100 });
    expect(first.classList.contains("selected")).toBe(true);
    expect(second.classList.contains("selected")).toBe(true);
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 390, clientY: 140 });
    expect(parseFloat(first.style.left)).toBeCloseTo(260);
    expect(parseFloat(first.style.top)).toBeCloseTo(240);
    expect(parseFloat(second.style.left)).toBeCloseTo(560);
    expect(parseFloat(second.style.top)).toBeCloseTo(240);
    fireEvent.click(screen.getByRole("button", { name: "Align selected blocks left" }));
    expect(parseFloat(first.style.left)).toBeCloseTo(260);
    expect(parseFloat(second.style.left)).toBeCloseTo(260);
    fireEvent.click(screen.getByRole("button", { name: "Clear selected workflow blocks" }));
    expect(first.classList.contains("selected")).toBe(false);
    expect(second.classList.contains("selected")).toBe(false);
  });

  it("aligns only selected blocks to the requested outer edge or center", () => {
    const blocks = [
      { id: "first", type: "text" as const, label: "First", prompt: "", position: { x: 20, y: 40 } },
      { id: "second", type: "text" as const, label: "Second", prompt: "", position: { x: 400, y: 300 } },
      { id: "other", type: "text" as const, label: "Other", prompt: "", position: { x: 800, y: 600 } },
    ];
    expect(alignBlocks(blocks, ["first", "second"], "center").map((block) => block.position)).toEqual([{ x: 210, y: 40 }, { x: 210, y: 300 }, { x: 800, y: 600 }]);
    expect(alignBlocks(blocks, ["first", "second"], "bottom").map((block) => block.position)).toEqual([{ x: 20, y: 300 }, { x: 400, y: 300 }, { x: 800, y: 600 }]);
  });

  it("drags and updates connection geometry after zoom, but leaves View mode fixed", () => {
    const { canvas } = renderZoomHarness();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const node = screen.getByLabelText("First response preview").closest(".harness-block") as HTMLElement;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({ left: 120, top: 100 } as DOMRect);
    node.setPointerCapture = vi.fn();
    const edge = screen.getByLabelText("Workflow connections").querySelector(".harness-edge")!;
    const originalPath = edge.getAttribute("d");
    // Grab 30/20 workflow pixels inside the node; the move uses scaled scroll coordinates.
    fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: 156, clientY: 124 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 100 + 300 * 1.2 - canvas.scrollLeft, clientY: 80 + 280 * 1.2 - canvas.scrollTop });
    expect(parseFloat(node.style.left)).toBeCloseTo(270);
    expect(parseFloat(node.style.top)).toBeCloseTo(260);
    expect(edge.getAttribute("d")).not.toBe(originalPath);
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 900, clientY: 900 });
    expect(parseFloat(node.style.left)).toBeCloseTo(270);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.pointerDown(node, { pointerId: 2, button: 0, clientX: 156, clientY: 124 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 900, clientY: 900 });
    expect(parseFloat(node.style.left)).toBeCloseTo(270);
    vi.restoreAllMocks();
  });

  it.each([0.5, 2])("drags with workflow coordinates at %sx including scroll and grab offset", (zoom) => {
    // The grabbed workflow point is (230, 220); move by 60/40 screen pixels.
    const scrollLeft = 100; const scrollTop = 50;
    const clientX = 100 + 230 * zoom - scrollLeft + 60;
    const clientY = 80 + 220 * zoom - scrollTop + 40;
    expect(dragPosition(clientX, clientY, 100, 80, scrollLeft, scrollTop, 30, 20, zoom)).toEqual({ x: 200 + 60 / zoom, y: 200 + 40 / zoom });
  });

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

  it("announces validation and selected run-state changes", async () => {
    const issue = { code: "missing-prompt", blockId: "a", message: "First needs instructions" };
    const props = { harnesses: [zoomHarness], providers: [], agents: [], onCreate: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(), onRun: vi.fn(), onCancelRun: vi.fn(), onError: vi.fn() };
    const view = render(<HarnessPanel {...props} runs={[]} onValidate={vi.fn().mockResolvedValue({ valid: false, issues: [issue] })} />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Workflow validation status" }).textContent).toContain("1 workflow validation issue"));
    const running: HarnessRun = { id: "run-1", harnessId: "zoom", harnessVersion: 1, input: "work", status: "running", createdAt: "now", blocks: [] };
    view.rerender(<HarnessPanel {...props} runs={[running]} />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Workflow run status" }).textContent).toContain("Workflow run run-1 is running"));
    view.rerender(<HarnessPanel {...props} runs={[{ ...running, status: "succeeded", completedAt: "later" }]} />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Workflow run status" }).textContent).toContain("Workflow run run-1 is succeeded"));
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

  it("connects blocks with Enter and Space from focused ports", async () => {
    const harness: HarnessDefinition = { id: "keyboard-flow", name: "Keyboard flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "source", type: "prompt", label: "Source", prompt: "", position: { x: 20, y: 20 } },
      { id: "target", type: "prompt", label: "Target", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    const output = await screen.findByRole("button", { name: "Connect from Source" });
    const input = screen.getByRole("button", { name: "Connect into Target" });
    expect(output.getAttribute("aria-keyshortcuts")).toBe("Enter Space");
    fireEvent.keyDown(output, { key: "Enter" });
    expect(input.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(input, { key: " " });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges).toMatchObject([{ from: "source", to: "target", type: "follow" }]));
  });

  it("edits blocks and connections from the ordered list without the canvas", async () => {
    const harness: HarnessDefinition = { id: "list-flow", name: "List flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
      { id: "source", type: "prompt", label: "Source", prompt: "", position: { x: 20, y: 20 } },
      { id: "target", type: "prompt", label: "Target", prompt: "", position: { x: 260, y: 20 } },
    ], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByLabelText("Workflow list editor")).toBeTruthy();
    expect(screen.queryByLabelText("Workflow canvas")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit block Source" }));
    expect((screen.getByLabelText("Block prompt") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("List connection source"), { target: { value: "source" } });
    fireEvent.change(screen.getByLabelText("List connection target"), { target: { value: "target" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByRole("button", { name: "Edit connection Source then Target" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].edges).toMatchObject([{ from: "source", to: "target", type: "follow" }]));
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
    const onLoadModels = vi.fn().mockResolvedValue([{ id: "gpt-test", name: "GPT Test", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"] }]);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} defaultProvider="codex" onLoadModels={onLoadModels} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(await screen.findByText("Plan"));
    fireEvent.click(await screen.findByRole("button", { name: "AI model" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT Test/ }));
    fireEvent.change(await screen.findByLabelText("Workflow reasoning effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave.mock.calls.at(0)?.[0].blocks[0].model).toBe("gpt-test"));
    expect(onSave.mock.calls.at(0)?.[0].blocks[0].reasoning).toBe("high");
  });

  it("saves declared JSON schemas and shows the validated run data", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    const runs = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, definition: { ...harness, settings: { tokenBudget: 20_000, maxActiveRuns: 2, maxBlockAttempts: 20, maxStackSize: 10, maxLoopCount: 5, maxChildTasks: 8 } }, input: '{"featureId":"F-1"}', status: "succeeded" as const, createdAt: "now", blocks: [{ blockId: "a", status: "succeeded" as const, tokens: { total: 12_345, input: 8_000, output: 4_345 }, structuredInput: { featureId: "F-1" }, structuredOutput: { commitSha: "abc123" } }] }];
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
    expect(details.textContent).toContain("Tokens: 12,345");
    expect(details.textContent).toContain("Run run-1 · definition v1");
    expect(details.textContent).toContain("12,345 tokens");
    expect(details.textContent).toContain("/ 20,000 budget");
    expect(details.textContent).toContain("Limits: 2 active runs · 20 block attempts · 10 stack inputs · 5 loop iterations · 8 child tasks");
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

  it("explains why a selected block is waiting and its next action", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", join: "all", position: { x: 20, y: 20 } }], edges: [] };
    const runs: HarnessRun[] = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "waiting", createdAt: "now", blocks: [{ blockId: "a", status: "waiting" }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByText("Review"));
    expect((await screen.findByLabelText("Block waiting status")).textContent).toContain("Waiting for every incoming synchronous connection to finish.");
  });

  it("shows the selected block's persisted attempt history", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs: HarnessRun[] = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded", createdAt: "now", blocks: [{ blockId: "a", status: "succeeded", attempts: [{ id: "first", index: 1, status: "failed", startedAt: "2026-09-18T00:00:00Z", completedAt: "2026-09-18T00:00:01Z", operationId: "first-operation", error: "Timed out" }, { id: "second", index: 2, status: "succeeded", startedAt: "2026-09-18T00:00:02Z", completedAt: "2026-09-18T00:00:03Z", operationId: "second-operation" }] }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByText("Review"));
    const details = await screen.findByLabelText("Review run details");
    expect(details.textContent).toContain("Attempts (2)");
    expect(details.textContent).toContain("Attempt 1 · failed");
    expect(details.textContent).toContain("Timed out");
    expect(details.textContent).toContain("Attempt 2 · succeeded");
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

  it("shows persisted run operations and block logs in chronological order", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs: HarnessRun[] = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded", createdAt: "2026-09-18T00:00:00Z", operations: [{ id: "attempt", idempotencyKey: "attempt", kind: "block_attempt", status: "succeeded", blockId: "a", createdAt: "2026-09-18T00:00:02Z", updatedAt: "2026-09-18T00:00:03Z" }], blocks: [{ blockId: "a", status: "succeeded", log: [{ timestamp: "2026-09-18T00:00:01Z", kind: "prompt", message: "Sent prompt" }, { timestamp: "2026-09-18T00:00:04Z", kind: "response", message: "Received answer" }] }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const timeline = await screen.findByLabelText("Workflow execution timeline");
    expect(timeline.textContent).toContain("Execution timeline (3)");
    const content = timeline.textContent ?? "";
    expect(content.indexOf("Sent prompt")).toBeLessThan(content.indexOf("block attempt"));
    expect(content.indexOf("block attempt")).toBeLessThan(content.indexOf("Received answer"));
  });

  it("paginates a long selected-run execution timeline", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Review", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const operations = Array.from({ length: 51 }, (_, index) => ({ id: `operation-${index}`, idempotencyKey: `operation-${index}`, kind: "dependency_decision" as const, status: "succeeded" as const, blockId: "a", createdAt: `2026-09-18T00:00:${String(index).padStart(2, "0")}Z`, updatedAt: `2026-09-18T00:00:${String(index).padStart(2, "0")}Z`, error: `Event number ${index + 1}.` }));
    const runs: HarnessRun[] = [{ id: "run-1", harnessId: harness.id, harnessVersion: 1, input: "task", status: "succeeded", createdAt: "2026-09-18T00:00:00Z", operations, blocks: [{ blockId: "a", status: "succeeded" }] }];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const timeline = await screen.findByLabelText("Workflow execution timeline");
    expect(timeline.textContent).toContain("Showing 1–50 of 51");
    expect(timeline.textContent).toContain("Event number 1.");
    expect(timeline.textContent).not.toContain("Event number 51.");
    fireEvent.click(screen.getByRole("button", { name: "Next timeline events" }));
    expect(timeline.textContent).toContain("Showing 51–51 of 51");
    expect(timeline.textContent).toContain("Event number 51.");
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

  it("duplicates a workflow using a new workflow identity", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 2, createdAt: "old", updatedAt: "old", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const copy = { ...harness, id: "copy", name: "Flow copy", version: 1, createdAt: "new", updatedAt: "new", blocks: [] };
    const onCreate = vi.fn().mockResolvedValue(copy); const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={onCreate} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate workflow" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Flow copy"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "copy", name: "Flow copy", version: 1, blocks: harness.blocks }));
  });

  it("duplicates the selected block with a new identity and offset", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "plan", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 30 }, inputSchema: { type: "object", required: ["featureId"] } }], edges: [] };
    const onSave = vi.fn().mockImplementation(async (value) => value);
    render(<HarnessPanel harnesses={[harness]} runs={[]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={onSave} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit block Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate selected block" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const copied = onSave.mock.calls.at(0)?.[0].blocks.find((item: HarnessBlock) => item.id !== "plan");
    expect(copied).toMatchObject({ label: "Plan copy", type: "prompt", prompt: "{{input}}", inputSchema: { type: "object", required: ["featureId"] }, position: { x: 52, y: 62 } });
    expect(copied.id).not.toBe("plan");
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

  it("compares the selected run with another run's block outcomes", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [{ id: "a", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 20, y: 20 } }], edges: [] };
    const runs: HarnessRun[] = [
      { id: "old", harnessId: harness.id, harnessVersion: 1, input: "old input", status: "failed", createdAt: "2026-01-01T00:00:00Z", blocks: [{ blockId: "a", status: "failed", tokens: { total: 100, input: 60, output: 40 } }] },
      { id: "current", harnessId: harness.id, harnessVersion: 1, input: "new input", status: "succeeded", createdAt: "2026-01-02T00:00:00Z", blocks: [{ blockId: "a", status: "succeeded", tokens: { total: 125, input: 75, output: 50 } }] },
    ];
    render(<HarnessPanel harnesses={[harness]} runs={runs} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onError={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Compare workflow run" }), { target: { value: "old" } });
    const comparison = await screen.findByLabelText("Workflow run comparison");
    expect(comparison.textContent).toContain("current (succeeded, 125 tokens) compared with old (failed, 100 tokens)");
    expect(comparison.textContent).toContain("current: succeeded · 125 tokens");
    expect(comparison.textContent).toContain("old: failed · 100 tokens");
  });

  it("confirms deletion of a completed selected run and disables it for active runs", async () => {
    const harness: HarnessDefinition = { id: "harness-1", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [], edges: [] };
    const completed: HarnessRun = { id: "completed", harnessId: harness.id, harnessVersion: 1, input: "work", status: "succeeded", createdAt: "2026-01-01T00:00:00Z", blocks: [] };
    const active: HarnessRun = { id: "active", harnessId: harness.id, harnessVersion: 1, input: "work", status: "running", createdAt: "2026-01-02T00:00:00Z", blocks: [] };
    const onDeleteRun = vi.fn().mockResolvedValue(undefined); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HarnessPanel harnesses={[harness]} runs={[completed, active]} providers={[]} agents={[]} onCreate={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} onCancelRun={vi.fn()} onDeleteRun={onDeleteRun} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect((await screen.findByRole("button", { name: "Delete selected workflow run" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Selected workflow run" }), { target: { value: "completed" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete selected workflow run" }));
    await waitFor(() => expect(onDeleteRun).toHaveBeenCalledWith("completed"));
    expect(confirm).toHaveBeenCalled(); confirm.mockRestore();
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
