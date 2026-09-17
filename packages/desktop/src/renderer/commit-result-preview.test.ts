import { expect, it } from "vitest";
import { buildCommitResultPreview, commitResultStates, hasConflictMarkers } from "./commit-result-preview";
import { applyBlock } from "./conflict-merge";
it("previews all clean changes preserving unrelated local edits and shifted lines", () => {
  const preview = buildCommitResultPreview("header\na\nseparator\nb\n", "intro\nheader\na\nseparator\nb\n", "header\nA\nseparator\nB\n");
  expect(preview.initial).toBe("intro\nheader\nA\nseparator\nB\n");
  expect(commitResultStates(preview, preview.initial).map((s) => s.conflict)).toEqual([false, false]);
  expect(commitResultStates(preview, preview.initial)[1]?.range).toEqual({ start: 4, end: 5 });
});
it("previews both conflicting versions and updates after resolving", () => {
  const preview = buildCommitResultPreview("old\nseparator\nb\n", "local\nseparator\nb\n", "incoming\nseparator\nB\n");
  expect(preview.initial).toBe("<<<<<<< LOCAL\nlocal\n=======\nincoming\n>>>>>>> COMMIT\nseparator\nB\n");
  expect(commitResultStates(preview, preview.initial).map((s) => s.conflict)).toEqual([true, false]);
  const resolved = applyBlock(preview.base, preview.initial, preview.blocks[0]!, "theirs", preview.blocks);
  expect(resolved).toBe("incoming\nseparator\nB\n");
  expect(hasConflictMarkers(resolved)).toBe(false);
});
it("handles additions, deletions, already-applied blocks and missing final newlines", () => {
  expect(buildCommitResultPreview("", "", "new").initial).toBe("new");
  expect(buildCommitResultPreview("old\n", "old\n", "").initial).toBe("");
  expect(buildCommitResultPreview("old\n", "new\n", "new\n").initial).toBe("new\n");
});
