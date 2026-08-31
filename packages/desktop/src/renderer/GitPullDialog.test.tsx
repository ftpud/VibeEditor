import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GitPullPreview } from "@remote-ide/protocol";
import { GitPullDialog } from "./GitPullDialog";

const preview: GitPullPreview = { branch: "main", upstream: "origin/main", head: "a".repeat(40), upstreamHead: "b".repeat(40), fetchedAt: "2026-08-31T10:00:00.000Z", ahead: 1, behind: 1, incoming: [{ hash: "b".repeat(40), shortHash: "bbbbbbb", author: "Test", date: "2026-08-31T09:00:00.000Z", subject: "incoming work" }], incomingTruncated: false, blockers: [], recovery: "Abort merge or rebase." };

describe("GitPullDialog", () => {
  it("shows fetched incoming commits, explicit strategies, and recovery", () => {
    const markup = renderToStaticMarkup(<GitPullDialog preview={preview} busy={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(markup).toContain("incoming work"); expect(markup).toContain("Merge"); expect(markup).toContain("Rebase"); expect(markup).toContain("Recovery:"); expect(markup).not.toContain("No incoming commits");
  });
  it("lists dirty blockers, promises no auto-stash, and disables both strategies", () => {
    const markup = renderToStaticMarkup(<GitPullDialog preview={{ ...preview, blockers: [{ path: "dirty.ts", indexStatus: " ", worktreeStatus: "M", states: ["worktree"] }] }} busy={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(markup).toContain("dirty.ts"); expect(markup).toContain("No automatic stash"); expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });
});
