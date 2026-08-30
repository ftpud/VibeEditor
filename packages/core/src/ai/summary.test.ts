import { describe, expect, it } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { summarizeAiSessions } from "./summary.js";

const session = (status: AiSession["status"], text: string, timestamp: string): AiSession => ({ model: "test", reasoning: "medium", status, messages: [{ id: text, role: "assistant", text, timestamp }] });

describe("summarizeAiSessions", () => {
  it("reports completed activity as done", () => {
    expect(summarizeAiSessions([session("done", "Finished work", "2026-08-26T10:00:00Z")])).toEqual({ status: "done", preview: "Finished work", pendingPermission: false });
  });

  it("prioritizes an active provider over newer inactive history", () => {
    expect(summarizeAiSessions([session("in_progress", "Working", "2026-08-26T09:00:00Z"), session("done", "Previous work", "2026-08-26T10:00:00Z")])).toEqual({ status: "in_progress", preview: "Working", pendingPermission: false });
  });
});
