import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskCheckpoint } from "@remote-ide/protocol";
import { CheckpointHandoff, TaskCheckpointHistory } from "./App";

const checkpoint: TaskCheckpoint = { id: "one", promptId: "prompt-one", provider: "codex", prompt: "Add prompt history", startedAt: "2026-08-28T10:00:00Z", completedAt: "2026-08-28T10:01:00Z", status: "completed", files: [{ path: "src/history.ts", status: "A", binary: false, size: 42 }], provenance: { model: "gpt-5", reasoning: "low", agent: { name: "Oleg", fingerprint: "abc" }, attachments: [{ name: "brief.md", kind: "resource" }], usage: { total: 42, input: 20, output: 22 }, commit: "1234567890abcdef" } };

describe("TaskCheckpointHistory", () => {
  it("groups recorded changes under prompt metadata", () => {
    const markup = renderToStaticMarkup(<TaskCheckpointHistory checkpoints={[checkpoint]} onOpen={() => undefined} onReview={() => undefined} onRestore={() => undefined} onFollowUp={() => undefined} />);
    expect(markup).toContain("Prompt History"); expect(markup).toContain("Add prompt history");
    const handoff = renderToStaticMarkup(<CheckpointHandoff checkpoint={checkpoint} />);
    expect(handoff).toContain("Handoff"); expect(handoff).toContain("Model: gpt-5 (low)"); expect(handoff).toContain("Attachments: brief.md"); expect(handoff).toContain("Commit: 1234567890ab");
  });

  it("explains an empty durable history", () => {
    expect(renderToStaticMarkup(<TaskCheckpointHistory checkpoints={[]} onOpen={() => undefined} onReview={() => undefined} onRestore={() => undefined} onFollowUp={() => undefined} />)).toContain("Prompt checkpoints appear");
  });
});
