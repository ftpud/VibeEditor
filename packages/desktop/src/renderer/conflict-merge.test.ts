import { describe, expect, it } from "vitest";
import { applyBlock, blockStates, mergeBlocks, mergeNonConflicting } from "./conflict-merge";

describe("three-way conflict merging", () => {
  it("tracks adjacent merged changes even when the line diff combines replacements", () => {
    const base = "a\nb\nc\n";
    const blocks = mergeBlocks(base, "A\nb\nc\n", "a\nB\nc\n");
    const result = mergeNonConflicting(base, base, blocks);
    expect(blockStates(base, result, blocks).map((state) => state.status)).toEqual(["merged", "merged"]);
    expect(applyBlock(base, result, blocks[0]!, "theirs", blocks)).toBe("a\nB\nc\n");
  });
  it("distinguishes unresolved markers, chosen versions, and custom results", () => {
    const blocks = mergeBlocks("base\n", "ours\n", "theirs\n");
    expect(blockStates("base\n", "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n", blocks)[0]!.status).toBe("conflict");
    expect(blockStates("base\n", "ours\n", blocks)[0]!.status).toBe("merged");
    expect(blockStates("base\n", "custom\n", blocks)[0]!.status).toBe("review");
  });
  it("merges independent changes, including adjacent edits", () => {
    const base = "a\nb\nc\n";
    const blocks = mergeBlocks(base, "A\nb\nc\n", "a\nB\nc\n");
    expect(blocks.every((block) => !block.conflict)).toBe(true);
    expect(mergeNonConflicting(base, base, blocks)).toBe("A\nB\nc\n");
  });
  it("leaves conflicting changes for a choice while merging safe changes", () => {
    const base = "a\nseparator\nb\n";
    const blocks = mergeBlocks(base, "ours\nseparator\nB\n", "theirs\nseparator\nb\n");
    expect(blocks[0]!.conflict).toBe(true);
    expect(mergeNonConflicting(base, base, blocks)).toBe("a\nseparator\nB\n");
    expect(applyBlock(base, "a\nseparator\nB\n", blocks[0]!, "theirs")).toBe("theirs\nseparator\nB\n");
  });
  it("replaces Git markers and preserves safe changes already in the result", () => {
    const base = "a\nseparator\nb\n";
    const result = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\nseparator\nB\n";
    const blocks = mergeBlocks(base, "ours\nseparator\nB\n", "theirs\nseparator\nb\n");
    expect(applyBlock(base, result, blocks[0]!, "ours")).toBe("ours\nseparator\nB\n");
    expect(mergeNonConflicting(base, result, blocks)).toBe(result);
  });
  it("handles insertions, deletions, identical edits, and missing final newlines", () => {
    const inserted = mergeBlocks("", "new", "other");
    expect(inserted[0]!.conflict).toBe(true);
    expect(applyBlock("", "", inserted[0]!, "theirs")).toBe("other");
    const base = "a\nkeep\nz";
    const blocks = mergeBlocks(base, "keep\nz", "a\nkeep\nz\nadded");
    expect(mergeNonConflicting(base, base, blocks)).toBe("keep\nz\nadded");
    expect(mergeNonConflicting("a\n", "a\n", mergeBlocks("a\n", "same\n", "same\n"))).toBe("same\n");
  });
  it("preserves manual edits and refuses ambiguous replacements spanning blocks", () => {
    const base = "a\nkeep\nb\n";
    const blocks = mergeBlocks(base, "A\nkeep\nb\n", "a\nkeep\nB\n");
    expect(mergeNonConflicting(base, "manual\nkeep\nb\n", blocks)).toBe("manual\nkeep\nB\n");
    expect(() => applyBlock(base, "rewritten entirely\n", blocks[0]!, "ours")).toThrow("Manual edits span multiple blocks");
  });
  it("preserves CRLF and applies the same insertion only once", () => {
    const base = "a\r\n";
    const blocks = mergeBlocks(base, "a\r\nnew\r\n", base);
    const result = mergeNonConflicting(base, base, blocks);
    expect(result).toBe("a\r\nnew\r\n");
    expect(mergeNonConflicting(base, result, blocks)).toBe(result);
    expect(applyBlock(base, result, blocks[0]!, "ours")).toBe(result);
  });
});
