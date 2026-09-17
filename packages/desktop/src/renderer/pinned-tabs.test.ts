import { describe, expect, it } from "vitest";
import { editorTabLabel, type EditorTab } from "./model";
import { orderPinnedTabs, pinnedFilePaths, togglePinnedTab } from "./pinned-tabs";

const tab = (id: string, pinned = false): EditorTab => ({ id, type: "file", title: id, path: `src/${id}.ts`, pinned, dirty: false, content: "", savedContent: "", loading: false });

describe("pinned tabs", () => {
  it("derives file labels from the path instead of a project-shaped tree title", () => {
    expect(editorTabLabel({ ...tab("file"), title: "MyProject", path: "src/components/Button.tsx" })).toBe("Button.tsx");
    expect(editorTabLabel({ ...tab("diff"), type: "diff", title: "Button.tsx (Diff)" })).toBe("Button.tsx (Diff)");
  });

  it("uses a stable leading pinned section and preserves relative order", () => {
    expect(orderPinnedTabs([tab("a"), tab("b", true), tab("c"), tab("d", true)]).map((item) => item.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("pins and unpins through the same stable ordering rule", () => {
    expect(togglePinnedTab([tab("a"), tab("b", true), tab("c")], "c").map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(togglePinnedTab([tab("b", true), tab("c", true), tab("a")], "b").map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("persists only pinned file paths in displayed order", () => {
    expect(pinnedFilePaths([tab("b", true), { ...tab("diff", true), type: "diff" }, tab("a", true)])).toEqual(["src/b.ts", "src/a.ts"]);
  });
});
