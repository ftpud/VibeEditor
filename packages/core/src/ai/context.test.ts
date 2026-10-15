import { describe, expect, it } from "vitest";
import type { AiSession } from "@remote-ide/acp";
import { captureContextInstructions, refreshContext } from "./context.js";

const session = (): AiSession => ({ model: "test", reasoning: "", status: "done", messages: [] });

describe("captured context", () => {
  it("counts tool replacements once and separates known files and reasoning from UI notices", () => {
    const current = session();
    current.messages = [
      { id: "tool", role: "activity", contextKind: "tools", text: "first", timestamp: "now" },
      { id: "file", role: "activity", contextKind: "files", text: "source", timestamp: "now" },
      { id: "reasoning", role: "activity", contextKind: "reasoning", text: "thought", timestamp: "now" },
      { id: "notice", role: "activity", text: "Connecting to provider", timestamp: "now" },
    ];
    refreshContext(current);
    current.messages[0]!.text = "replaced output";
    refreshContext(current);
    expect(current.context?.sections.find((section) => section.id === "tools")).toMatchObject({ characters: 15, count: 1 });
    expect(current.context?.sections.find((section) => section.id === "files")?.characters).toBe(6);
    expect(current.context?.sections.find((section) => section.id === "reasoning")?.characters).toBe(7);
    expect(current.context?.sections.find((section) => section.id === "conversation")?.characters).toBe(0);
  });

  it("counts embedded text once and leaves image and link token sizes unknown", () => {
    const current = session();
    current.messages.push({ id: "user", role: "user", text: "hello", timestamp: "now", content: [
      { type: "text", text: "hello" }, { type: "resource", uri: "file:///source.ts", text: "code" },
      { type: "image", mimeType: "image/png", data: "base64".repeat(1000) },
      { type: "resource_link", uri: "file:///large.ts", name: "large.ts", size: 1_000_000 },
    ] });
    refreshContext(current);
    expect(current.context?.sections.find((section) => section.id === "conversation")?.characters).toBe(5);
    expect(current.context?.sections.find((section) => section.id === "files")).toMatchObject({ characters: 4, count: 3 });
  });

  it("bounds previews and usage history, preserves decreases, and does not invent per-category tokens", () => {
    const current = session();
    for (let index = 0; index < 30; index++) captureContextInstructions(current, "Agent", "x".repeat(2000));
    for (let index = 0; index < 130; index++) { current.contextUsed = index * 100; current.contextLimit = 100_000; refreshContext(current, true); }
    current.contextUsed = 100;
    refreshContext(current, true);
    refreshContext(current, true);
    const instructions = current.context!.sections.find((section) => section.id === "instructions")!;
    expect(instructions.characters).toBe(60_000);
    expect(instructions.entries).toHaveLength(12);
    expect(instructions.entries.every((item) => item.preview.length === 1600)).toBe(true);
    expect(current.context!.history).toHaveLength(120);
    expect(current.context!.history.at(-2)?.used).toBe(12_900);
    expect(current.context!.history.at(-1)?.used).toBe(100);
    expect(current.context!.history.at(-1)?.characters).toBe(60_000);
    expect(session().context).toBeUndefined();
  });
});
