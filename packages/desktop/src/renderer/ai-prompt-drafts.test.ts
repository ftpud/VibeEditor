import { afterEach, describe, expect, it } from "vitest";
import { readAiPromptDraft, writeAiPromptDraft } from "./ai-prompt-drafts";

afterEach(() => localStorage.clear());

describe("AI prompt drafts", () => {
  it("restores each task's draft without leaking it into another task or the root workspace", () => {
    writeAiPromptDraft("/workspace", undefined, "codex", "root-session", "root draft");
    writeAiPromptDraft("/workspace", "task-a", "codex", "task-session", "task A draft");
    writeAiPromptDraft("/workspace", "task-b", "codex", "task-session", "task B draft");

    expect(readAiPromptDraft("/workspace", "task-a", "codex", "task-session")).toBe("task A draft");
    expect(readAiPromptDraft("/workspace", "task-b", "codex", "task-session")).toBe("task B draft");
    expect(readAiPromptDraft("/workspace", undefined, "codex", "root-session")).toBe("root draft");
  });

  it("isolates conversations and clears only the accepted conversation draft", () => {
    writeAiPromptDraft("/workspace", "task-a", "codex", "conversation-one", "first draft");
    writeAiPromptDraft("/workspace", "task-a", "codex", "conversation-two", "second draft");
    writeAiPromptDraft("/workspace", "task-a", "codex", "conversation-one", "");

    expect(readAiPromptDraft("/workspace", "task-a", "codex", "conversation-one")).toBe("");
    expect(readAiPromptDraft("/workspace", "task-a", "codex", "conversation-two")).toBe("second draft");
  });
});
