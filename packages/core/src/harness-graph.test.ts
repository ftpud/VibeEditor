import { describe, expect, it } from "vitest";
import type { HarnessDefinition } from "@remote-ide/protocol";
import { parseHarnessData, renderHarnessPrompt, validateHarness } from "./harness-graph.js";

const harness = (edges: HarnessDefinition["edges"]): HarnessDefinition => ({ id: "h", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
  { id: "plan", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 0, y: 0 } },
  { id: "build", type: "prompt", label: "Build", prompt: "{{blocks.plan.output}}", position: { x: 200, y: 0 } }
], edges });

describe("harness graph", () => {
  it("requires explicit, valid Core gate configuration", () => {
    const invalid: HarnessDefinition = { ...harness([]), blocks: [
      { id: "review", type: "review", label: "Review", prompt: "Review", position: { x: 0, y: 0 } },
      { id: "verify", type: "verification", label: "Verify", prompt: "Verify", verification: { command: "", timeoutMs: 0 }, position: { x: 0, y: 0 } }
    ] };
    expect(validateHarness(invalid).issues.filter((issue) => issue.code === "invalid-gate")).toHaveLength(2);
    const valid: HarnessDefinition = { ...invalid, blocks: [
      { id: "review", type: "review", label: "Review", prompt: "Review", review: { revision: "abc1234" }, position: { x: 0, y: 0 } },
      { id: "verify", type: "verification", label: "Verify", prompt: "Verify", verification: { command: "npm test", revision: "abc1234", workingDirectory: ".", timeoutMs: 60_000 }, position: { x: 0, y: 0 } }
    ] };
    expect(validateHarness(valid).issues).toEqual([]);
  });
  it("returns a stable dependency order", () => expect(validateHarness(harness([{ id: "e", from: "plan", to: "build" }]))).toMatchObject({ valid: true, order: ["plan", "build"] }));
  it("validates the configured workflow concurrency", () => {
    expect(validateHarness({ ...harness([]), settings: { concurrency: 2, maxActiveRuns: 2, maxBlockAttempts: 20, maxStackSize: 10, retry: { maxAttempts: 5 }, outputLimitChars: 5_000, logLimitEntries: 25, maxRunDurationMs: 15 * 60_000, tokenBudget: 50_000 } }).issues).toEqual([]);
    expect(validateHarness({ ...harness([]), settings: { concurrency: 0 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { maxActiveRuns: 0 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { maxBlockAttempts: 0 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { maxStackSize: 0 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { retry: { maxAttempts: 11 } } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { outputLimitChars: 999 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { logLimitEntries: 9 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { maxRunDurationMs: 59_999 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
    expect(validateHarness({ ...harness([]), settings: { tokenBudget: 999 } }).issues).toMatchObject([{ code: "invalid-settings" }]);
  });
  it("rejects cycles and missing endpoints", () => {
    expect(validateHarness(harness([{ id: "a", from: "plan", to: "build" }, { id: "b", from: "build", to: "plan" }])).issues.some((issue) => issue.code === "cycle")).toBe(true);
    expect(validateHarness(harness([{ id: "a", from: "missing", to: "build" }])).issues.some((issue) => issue.code === "missing-endpoint")).toBe(true);
  });
  it("allows an explicit loop edge without adding it to dependency order", () => {
    const looped = harness([{ id: "forward", from: "plan", to: "build" }, { id: "loop", from: "build", to: "plan", loop: true }]);
    expect(validateHarness(looped)).toMatchObject({ valid: true, order: ["plan", "build"] });
  });
  it("requires watchdogs to be independent and supervise delivery work", () => {
    const onlyWatchdog = harness([]); onlyWatchdog.blocks = [{ id: "watch", type: "prompt", label: "Watch", prompt: "", watchdog: true, position: { x: 0, y: 0 } }];
    expect(validateHarness(onlyWatchdog).issues.map((issue) => issue.code)).toContain("invalid-watchdog");
    const connectedWatchdog = harness([{ id: "watch-edge", from: "plan", to: "build" }]); connectedWatchdog.blocks[0]!.watchdog = true;
    expect(validateHarness(connectedWatchdog).issues).toMatchObject([{ code: "invalid-watchdog", edgeId: "watch-edge" }]);
  });
  it("only resolves supported template variables", () => expect(renderHarnessPrompt("Input={{input}} output={{blocks.plan.output}} {{unknown}}", "task", new Map([["plan", "result"]]))).toBe("Input=task output=result {{unknown}}"));
  it("requires unique path labels for AI routing", () => {
    const routed = harness([{ id: "a", from: "plan", to: "build" }]); routed.blocks[0]!.routing = "ai";
    expect(validateHarness(routed).issues).toMatchObject([{ code: "route-label", blockId: "plan", edgeId: "a" }]);
  });
  it("rejects incomplete blocks, bad templates, duplicate edge IDs, and invalid loops", () => {
    const invalid = harness([
      { id: "same", from: "plan", to: "build" },
      { id: "same", from: "plan", to: "build" },
      { id: "loop", from: "plan", to: "build", loop: true }
    ]);
    invalid.blocks[0] = { ...invalid.blocks[0]!, label: " ", prompt: "{{unknown}} {{blocks.missing.output}}" };
    expect(validateHarness(invalid).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["empty-label", "unknown-template", "missing-template-block", "duplicate-edge-id", "duplicate-edge", "invalid-loop"]));
  });
  it("validates bounded structured input and output schemas", () => {
    const typed = harness([]); typed.blocks[0]!.outputSchema = { type: "object", required: ["summary"], properties: { summary: { type: "string" }, checks: { type: "array", items: { type: "boolean" } } } };
    expect(validateHarness(typed).valid).toBe(true);
    expect(parseHarnessData('{"summary":"done","checks":[true,false]}', typed.blocks[0]!.outputSchema, "Plan output")).toEqual({ summary: "done", checks: [true, false] });
    expect(() => parseHarnessData('{"checks":[true]}', typed.blocks[0]!.outputSchema, "Plan output")).toThrow("missing required field 'summary'");
  });
});
