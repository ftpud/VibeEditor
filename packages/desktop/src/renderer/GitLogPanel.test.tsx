import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLogPanel, TagGroup } from "./GitLogPanel";
import type { CoreClient } from "./client";

afterEach(cleanup);

describe("TagGroup", () => {
  const tags = [{ name: "v1.0.0", target: "a".repeat(40), annotated: false }];

  it("labels tag effects as local and selects a tag for history browsing", () => {
    const onSelect = vi.fn();
    render(<TagGroup tags={tags} selected="" disabled={false} onSelect={onSelect} onCreate={vi.fn()} onContextMenu={vi.fn()} />);
    expect(screen.getByText("Create/delete affects this local repository only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /v1\.0\.0/ }));
    expect(onSelect).toHaveBeenCalledWith("v1.0.0");
  });

  it("does not enable local tag creation until a commit is selected", () => {
    render(<TagGroup tags={[]} selected="" disabled={true} onSelect={vi.fn()} onCreate={vi.fn()} onContextMenu={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Create local tag" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("history ref merge actions", () => {
  it("invokes a typed local-branch merge from the graph ref menu", async () => {
    const hash = "a".repeat(40); const refHead = "b".repeat(40);
    const request = vi.fn(async (type: string, payload: unknown) => {
      if (type === "git.branches") return { branches: [{ name: "main", current: true, remote: false }, { name: "feature", current: false, remote: false }] };
      if (type === "git.tags") return { tags: [{ name: "v1", target: refHead, annotated: false }] };
      if (type === "git.log") return { commits: [] };
      if (type === "git.mergePreview") return { source: (payload as { source: unknown }).source, fullRef: "refs/heads/feature", branch: "main", head: hash, refHead, mergeBase: hash, outcome: "fast-forward", incoming: [], incomingTruncated: false, blockers: [], recovery: "Local only." };
      if (type === "git.merge") return { state: "completed", outcome: "fast-forward", branch: "main", head: refHead, message: "done", recovery: "Local only." };
      throw new Error(type);
    });
    render(<GitLogPanel client={{ request } as unknown as CoreClient} height={400} onResizeStart={() => undefined} />);
    const feature = await screen.findByRole("button", { name: /feature/ }); fireEvent.contextMenu(feature);
    fireEvent.click(screen.getByRole("button", { name: /merge into current branch/i }));
    await screen.findByRole("dialog", { name: "Merge feature" });
    expect(request).toHaveBeenCalledWith("git.mergePreview", { source: { kind: "local-branch", name: "feature" } });
    fireEvent.click(screen.getByRole("button", { name: /merge locally/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("git.merge", { source: { kind: "local-branch", name: "feature" }, expectedHead: hash, expectedRefHead: refHead, expectedMergeBase: hash }));
  });

  it("offers the same local-only preview action for a tag", async () => {
    const request = vi.fn(async (type: string) => type === "git.branches" ? { branches: [{ name: "main", current: true, remote: false }] } : type === "git.tags" ? { tags: [{ name: "v1", target: "b".repeat(40), annotated: false }] } : type === "git.log" ? { commits: [] } : { source: { kind: "tag", name: "v1" }, fullRef: "refs/tags/v1", branch: "main", head: "a".repeat(40), refHead: "b".repeat(40), mergeBase: "a".repeat(40), outcome: "fast-forward", incoming: [], incomingTruncated: false, blockers: [], recovery: "Local only." });
    render(<GitLogPanel client={{ request } as unknown as CoreClient} height={400} onResizeStart={() => undefined} />);
    const tag = await screen.findByRole("button", { name: /v1/ }); fireEvent.contextMenu(tag); fireEvent.click(screen.getByRole("button", { name: /merge into current branch/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("git.mergePreview", { source: { kind: "tag", name: "v1" } }));
  });
});
