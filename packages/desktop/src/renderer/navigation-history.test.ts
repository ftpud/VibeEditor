import { describe, expect, it } from "vitest";
import { NavigationHistory } from "./navigation-history";

describe("NavigationHistory", () => {
  it("navigates back and forward and drops the forward branch after a new visit", () => {
    const history = new NavigationHistory(); const a = { path: "a.ts", line: 1, column: 1 }; const b = { path: "b.ts", line: 2, column: 3 }; const c = { path: "c.ts", line: 4, column: 5 };
    history.visit(a); history.visit(b); expect(history.back()).toEqual(a); expect(history.forward()).toEqual(b); expect(history.back()).toEqual(a); history.visit(c); expect(history.forward()).toBeUndefined(); expect(history.back()).toEqual(a);
  });
});
