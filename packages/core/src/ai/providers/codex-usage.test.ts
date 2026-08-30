import { describe, expect, it } from "vitest";
import { parseCodexAccountQuota } from "./codex-usage.js";

describe("Codex account quota", () => {
  it("maps rolling rate-limit windows and credits", () => {
    expect(parseCodexAccountQuota({ rateLimits: {
      limitId: "codex", planType: "plus",
      primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_788_098_122 },
      secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 1_788_684_922 },
      credits: { hasCredits: false, unlimited: false, balance: "0" }
    } })).toEqual({
      limitId: "codex", plan: "plus",
      primary: { usedPercent: 27, remainingPercent: 73, windowMinutes: 300, resetsAt: "2026-08-30T13:55:22.000Z" },
      secondary: { usedPercent: 4, remainingPercent: 96, windowMinutes: 10_080, resetsAt: "2026-09-06T08:55:22.000Z" },
      credits: { hasCredits: false, unlimited: false, balance: "0" }
    });
  });

  it("returns undefined for a response without rate limits", () => {
    expect(parseCodexAccountQuota({})).toBeUndefined();
  });
});
