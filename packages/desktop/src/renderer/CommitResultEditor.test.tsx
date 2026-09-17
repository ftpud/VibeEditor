import { useEffect, useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommitResultEditor } from "./CommitResultEditor";
import { buildCommitResultPreview } from "./commit-result-preview";
const mocks = vi.hoisted(() => ({ decorations: vi.fn(), reveal: vi.fn(), props: vi.fn(), clear: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({ DiffEditor: function MockDiff(props: { original: string; modified: string; onMount(value: unknown): void }) {
  mocks.props(props);
  const value = useRef(props.modified); value.current = props.modified;
  useEffect(() => {
    const code = { getModel: () => ({ getLineCount: () => 100 }), getValue: () => value.current, onDidChangeModelContent: () => ({ dispose() {} }), createDecorationsCollection: (decorations: unknown) => { mocks.decorations(decorations); return { clear: mocks.clear }; }, revealLineInCenter: mocks.reveal, setPosition: vi.fn() };
    props.onMount({ getOriginalEditor: () => code, getModifiedEditor: () => code });
  }, []);
  return <div />;
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("uses syntax highlighting and an editable local diff with blue/red block decorations", async () => {
  const preview = buildCommitResultPreview("old\nseparator\nb\n", "local\nseparator\nb\n", "incoming\nseparator\nB\n");
  const props = { path: "file.ts", preview, result: preview.initial, busy: false, onChange: vi.fn(), onEditor: vi.fn() };
  const view = render(<CommitResultEditor {...props} selected={0} />);
  await waitFor(() => expect(mocks.decorations).toHaveBeenCalled());
  const passed = mocks.props.mock.calls.at(-1)![0];
  expect(passed.original).toBe(preview.local);
  expect(passed.language).toBe("typescript");
  expect(passed.options).toMatchObject({ readOnly: false, originalEditable: false, renderSideBySide: false });
  const modified = mocks.decorations.mock.calls.at(-1)![0];
  expect(modified[0].options.className).toBe("commit-result-conflict commit-result-selected");
  expect(modified[1].options.className).toBe("commit-result-clean");
  view.rerender(<CommitResultEditor {...props} selected={1} />);
  await waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith(7));
  expect(mocks.clear).toHaveBeenCalled();
});
