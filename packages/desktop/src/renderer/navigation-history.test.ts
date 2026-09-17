import { describe, expect, it } from "vitest";
import { NavigationHistory } from "./navigation-history";

describe("NavigationHistory", () => {
  it("navigates back and forward and drops the forward branch after a new visit", () => {
    const history = new NavigationHistory(); const a = { rootId: "root-a", path: "a.ts", line: 1, column: 1 }; const b = { rootId: "root-b", path: "b.ts", line: 2, column: 3 }; const c = { rootId: "root-a", path: "c.ts", line: 4, column: 5 };
    history.visit(a); history.visit(b); expect(history.back()).toEqual(a); expect(history.forward()).toEqual(b); expect(history.back()).toEqual(a); history.visit(c); expect(history.forward()).toBeUndefined(); expect(history.back()).toEqual(a);
  });

  it("keeps the same relative location distinct across roots", () => {
    const history = new NavigationHistory();
    history.visit({ rootId: "root-a", path: "src/index.ts", line: 1, column: 1 });
    history.visit({ rootId: "root-b", path: "src/index.ts", line: 1, column: 1 });
    expect(history.back()).toEqual({ rootId: "root-a", path: "src/index.ts", line: 1, column: 1 });
  });
});
