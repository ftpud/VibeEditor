import { act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { JavaDebugState } from "@remote-ide/protocol";
import { attachDebugEditor, debugHoverExpression, resolveDebugHover } from "./debug-editor";

const paused: JavaDebugState = { status: "paused", path: "App.java", line: 7, variables: [{ name: "node", value: "Node", reference: "node" }] };
afterEach(() => vi.useRealTimers());

it("resolves nested fields and indexed elements without evaluating methods", async () => {
  expect(debugHoverExpression("  node.child.value;", 15)).toBe("node.child.value");
  const inspect = vi.fn().mockResolvedValueOnce({ variables: [{ name: "child", value: "Node", reference: "child" }] }).mockResolvedValueOnce({ variables: [{ name: "Base.value", value: "42" }] });
  expect(await resolveDebugHover("node.child.value", paused, inspect)).toEqual({ name: "node.child.value", value: "42" });
  const array = vi.fn().mockResolvedValue({ variables: [{ name: "[55]", value: "99" }] });
  expect((await resolveDebugHover("node[55]", paused, array))?.value).toBe("99");
  expect(array).toHaveBeenCalledWith("node", 55);
  expect(await resolveDebugHover("node", { ...paused, status: "running" }, inspect)).toBeUndefined();
});

it("highlights only the paused source, shows an expandable hover, and clears it on resume", async () => {
  vi.useFakeTimers();
  let mouseMove!: (event: any) => void;
  const decorations = { set: vi.fn(), clear: vi.fn() };
  const widgetNode = document.createElement("div"); document.body.append(widgetNode);
  const instance = {
    createDecorationsCollection: () => decorations,
    addContentWidget: (widget: editor.IContentWidget) => widgetNode.append(widget.getDomNode()),
    removeContentWidget: vi.fn(), layoutContentWidget: vi.fn(), revealLineInCenterIfOutsideViewport: vi.fn(),
    onMouseMove: (handler: typeof mouseMove) => { mouseMove = handler; return { dispose: vi.fn() }; },
    onDidDispose: () => ({ dispose: vi.fn() }),
    onMouseLeave: () => ({ dispose: vi.fn() }), onDidChangeModelContent: () => ({ dispose: vi.fn() }),
    getModel: () => ({ getWordAtPosition: () => ({ word: "node" }), getLineContent: () => "node" })
  } as unknown as editor.IStandaloneCodeEditor;
  const api = { editor: { ContentWidgetPositionPreference: { BELOW: 2, ABOVE: 1 }, OverviewRulerLane: { Full: 7 } } } as Monaco;
  const inspect = vi.fn().mockResolvedValue({ variables: [{ name: "value", value: "42" }] });
  const controller = attachDebugEditor(instance, api, "App.java", inspect);
  await act(async () => {
    controller.update(paused);
    mouseMove({ target: { position: { lineNumber: 7, column: 2 } } });
    await vi.advanceTimersByTimeAsync(350);
  });
  expect(decorations.set.mock.calls[0]![0][0].range.startLineNumber).toBe(7);
  expect(widgetNode.textContent).toContain("42");
  expect(widgetNode.querySelector('[aria-label="Collapse node"]')).toBeTruthy();
  await act(async () => controller.update({ ...paused, status: "running" }));
  expect(decorations.set).toHaveBeenLastCalledWith([]);
  expect(widgetNode.textContent).toBe("");
  await act(async () => controller.update({ ...paused, path: "Other.java" }));
  expect(decorations.set).toHaveBeenLastCalledWith([]);
  await act(async () => controller.dispose());
  widgetNode.remove();
});
