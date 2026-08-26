import { describe, expect, it } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { summarizeAiSessions } from "./ai-summary.js";

const session = (status: AiSession["status"], text: string, timestamp: string): AiSession => ({ model: "test", reasoning: "medium", status, messages: [{ id: text, role: "assistant", text, timestamp }] });

describe("summarizeAiSessions", () => {
  it("keeps completed activity as a preview without reporting a running status", () => {
    expect(summarizeAiSessions([session("done", "Finished work", "2026-08-26T10:00:00Z")])).toEqual({ status: "idle", preview: "Finished work" });
  });

  it("prioritizes an active provider over newer inactive history", () => {
    expect(summarizeAiSessions([session("in_progress", "Working", "2026-08-26T09:00:00Z"), session("done", "Previous work", "2026-08-26T10:00:00Z")])).toEqual({ status: "in_progress", preview: "Working" });
  });
});
