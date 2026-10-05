import { describe, expect, it } from "vitest";
import { functionStartDecorations, navigationFunctionStarts } from "./function-markers";

describe("function markers", () => {
  it("finds nested functions while ignoring classes and properties", () => {
    const starts = navigationFunctionStarts({ text: "module", kind: "module", childItems: [
      { text: "Example", kind: "class", spans: [{ start: 0, length: 100 }], childItems: [
        { text: "field", kind: "property", spans: [{ start: 10, length: 4 }] },
        { text: "run", kind: "method", spans: [{ start: 20, length: 40 }], nameSpan: { start: 30, length: 3 }, childItems: [
          { text: "nested", kind: "function", spans: [{ start: 50, length: 10 }] }
        ] }
      ] }
    ] }, { getPositionAt: (offset) => ({ lineNumber: offset / 10 + 1, column: 1 }) });
    expect(starts).toEqual([{ line: 4, name: "run" }, { line: 6, name: "nested" }]);
  });

  it("keeps declarations on one line from producing overlapping gutter markers", () => {
    const decorations = functionStartDecorations([{ line: 2, name: "first" }, { line: 2, name: "second" }, { line: 5, name: "third" }]);
    expect(decorations.map((item) => item.range.startLineNumber)).toEqual([2, 5]);
    expect(decorations[0]?.options.glyphMargin?.position).toBe(3);
  });
});
