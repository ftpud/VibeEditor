import { describe, expect, it } from "vitest";
import type { HarnessDefinition } from "@remote-ide/protocol";
import { renderHarnessPrompt, validateHarness } from "./harness-graph.js";

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
  it("only resolves supported template variables", () => expect(renderHarnessPrompt("Input={{input}} output={{blocks.plan.output}} {{unknown}}", "task", new Map([["plan", "result"]]))).toBe("Input=task output=result {{unknown}}"));
  it("requires unique path labels for AI routing", () => {
    const routed = harness([{ id: "a", from: "plan", to: "build" }]); routed.blocks[0]!.routing = "ai";
    expect(validateHarness(routed).issues).toMatchObject([{ code: "route-label", blockId: "plan", edgeId: "a" }]);
  });
});
