import { describe, expect, it } from "vitest";
import type { HarnessDefinition } from "@remote-ide/protocol";
import { parseHarnessData, renderHarnessPrompt, validateHarness } from "./harness-graph.js";

const harness = (edges: HarnessDefinition["edges"]): HarnessDefinition => ({ id: "h", name: "Flow", version: 1, createdAt: "now", updatedAt: "now", blocks: [
  { id: "plan", type: "prompt", label: "Plan", prompt: "{{input}}", position: { x: 0, y: 0 } },
  { id: "build", type: "prompt", label: "Build", prompt: "{{blocks.plan.output}}", position: { x: 200, y: 0 } }
], edges });

describe("harness graph", () => {
  it("returns a stable dependency order", () => expect(validateHarness(harness([{ id: "e", from: "plan", to: "build" }]))).toMatchObject({ valid: true, order: ["plan", "build"] }));
  it("rejects cycles and missing endpoints", () => {
    expect(validateHarness(harness([{ id: "a", from: "plan", to: "build" }, { id: "b", from: "build", to: "plan" }])).issues.some((issue) => issue.code === "cycle")).toBe(true);
    expect(validateHarness(harness([{ id: "a", from: "missing", to: "build" }])).issues.some((issue) => issue.code === "missing-endpoint")).toBe(true);
  });
  it("allows an explicit loop edge without adding it to dependency order", () => {
    const looped = harness([{ id: "forward", from: "plan", to: "build" }, { id: "loop", from: "build", to: "plan", loop: true }]);
    expect(validateHarness(looped)).toMatchObject({ valid: true, order: ["plan", "build"] });
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
