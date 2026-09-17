import { describe, expect, it } from "vitest";
import { menuPosition } from "./menu-position";

describe("menuPosition", () => {
  it("uses the viewport width for horizontal context-menu placement", () => {
    expect(menuPosition(1400, 400, 220, 100, 1600, 900)).toEqual({ x: 1380, y: 400 });
  });

  it("keeps menus inside the bottom and left viewport edges", () => {
    expect(menuPosition(-20, 880, 220, 100, 1600, 900)).toEqual({ x: 0, y: 800 });
  });
});
