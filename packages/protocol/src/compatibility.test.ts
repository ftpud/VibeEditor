import { describe, expect, it } from "vitest";
import { protocolRangesOverlap } from "./index.js";

describe("protocol compatibility", () => {
  it("requires an overlapping version range", () => {
    expect(protocolRangesOverlap({ minimum: 1, maximum: 2 }, { minimum: 2, maximum: 3 })).toBe(true);
    expect(protocolRangesOverlap({ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 2 })).toBe(false);
    expect(protocolRangesOverlap({ minimum: 3, maximum: 1 }, { minimum: 1, maximum: 3 })).toBe(false);
  });
});
