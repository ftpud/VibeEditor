import { useEffect } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommitBlockDiff, languageForPath } from "./CommitBlockDiff";
import { buildCommitResultPreview } from "./commit-result-preview";

const mocks = vi.hoisted(() => ({ props: vi.fn(), originalReveal: vi.fn(), modifiedReveal: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({ DiffEditor: function MockDiff(props: { onMount(value: unknown): void }) {
  mocks.props(props);
  useEffect(() => props.onMount({ getOriginalEditor: () => ({ revealLineInCenter: mocks.originalReveal }), getModifiedEditor: () => ({ revealLineInCenter: mocks.modifiedReveal }) }), []);
  return <div />;
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows the full parent-to-commit source diff and focuses the selected block", async () => {
  const preview = buildCommitResultPreview("one\nkeep\nold\n", "one\nkeep\nold\n", "one\nkeep\nnew\n");
  render(<CommitBlockDiff path="example.ts" preview={preview} selected={0} />);
  await waitFor(() => expect(mocks.originalReveal).toHaveBeenCalledWith(3));
  expect(mocks.modifiedReveal).toHaveBeenCalledWith(3);
  const props = mocks.props.mock.calls[0]![0];
  expect(props.original).toBe("one\nkeep\nold\n");
  expect(props.modified).toBe("one\nkeep\nnew\n");
  expect(props.language).toBe("typescript");
  expect(props.options).toMatchObject({ readOnly: true, renderSideBySide: false, hideUnchangedRegions: { enabled: true } });
});

it("selects syntax highlighting from the file path", () => {
  expect(languageForPath("src/file.py")).toBe("python");
  expect(languageForPath("LICENSE")).toBe("plaintext");
});
