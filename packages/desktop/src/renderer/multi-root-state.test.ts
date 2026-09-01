import { describe, expect, it } from "vitest";
import { mergeRootOwnedTabs } from "./model";

describe("multi-root tab state", () => {
  it("restores one root without losing simultaneous tabs from another", () => {
    const existing = [{ id: "a-old", rootId: "root-a" }, { id: "b", rootId: "root-b" }];
    expect(mergeRootOwnedTabs(existing, [{ id: "a-old", rootId: "root-a" }], "root-a", (item) => item.id)).toEqual(existing);
  });

  it("does not migrate ambiguous legacy tabs into a newly selected root", () => {
    expect(mergeRootOwnedTabs([{ id: "legacy" }, { id: "b", rootId: "root-b" }], [], "root-a", (item) => item.id)).toEqual([{ id: "b", rootId: "root-b" }]);
  });
});
