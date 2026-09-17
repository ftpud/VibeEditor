import { describe, expect, it } from "vitest";
import { reconcileProjectTree } from "./project-tree-reconciliation";

describe("project tree reconciliation", () => {
  it("uses the Core snapshot rather than watcher order", () => {
    const tree = [{ name: "src", path: "src", type: "directory" as const, children: [{ name: "old.ts", path: "src/old.ts", type: "file" as const }] }];
    expect(reconcileProjectTree(tree, [{ path: "src/old.ts" }, { path: "src/new.ts", type: "file" }])).toEqual([{ name: "src", path: "src", type: "directory", children: [{ name: "new.ts", path: "src/new.ts", type: "file" }] }]);
  });
});
