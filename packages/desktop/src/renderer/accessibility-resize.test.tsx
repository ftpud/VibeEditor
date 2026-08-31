import { describe, expect, it, vi } from "vitest";
import { keyboardResize } from "./App";

describe("keyboardResize", () => {
  it("supports arrows, larger Shift steps, bounds, and reversed right panels", () => {
    const update = vi.fn(); const preventDefault = vi.fn();
    keyboardResize({ key: "ArrowRight", shiftKey: false, preventDefault }, 300, update, 280, 400);
    keyboardResize({ key: "ArrowLeft", shiftKey: true, preventDefault }, 300, update, 280, 400);
    keyboardResize({ key: "ArrowRight", shiftKey: false, preventDefault }, 300, update, 280, 400, true);
    expect(update.mock.calls.map(([value]) => value)).toEqual([310, 280, 290]);
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });
});
