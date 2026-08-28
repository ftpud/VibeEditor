import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskCheckpoint } from "@remote-ide/protocol";
import { TaskCheckpointHistory } from "./App";

const checkpoint: TaskCheckpoint = { id: "one", promptId: "prompt-one", provider: "codex", prompt: "Add prompt history", startedAt: "2026-08-28T10:00:00Z", completedAt: "2026-08-28T10:01:00Z", status: "completed", files: [{ path: "src/history.ts", status: "A", binary: false, size: 42 }] };

describe("TaskCheckpointHistory", () => {
  it("groups recorded changes under prompt metadata", () => {
    const markup = renderToStaticMarkup(<TaskCheckpointHistory checkpoints={[checkpoint]} onOpen={() => undefined} onRestore={() => undefined} />);
    expect(markup).toContain("Prompt History"); expect(markup).toContain("Add prompt history"); expect(markup).toContain("codex"); expect(markup).toContain("completed");
  });

  it("explains an empty durable history", () => {
    expect(renderToStaticMarkup(<TaskCheckpointHistory checkpoints={[]} onOpen={() => undefined} onRestore={() => undefined} />)).toContain("Prompt checkpoints appear");
  });
});
