import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GitStatusEntry } from "@remote-ide/protocol";
import { GitToolbarActions, RollbackSelectedDialog, executeRollbackSelection, selectedGitEntries, shouldApplyGitStatus } from "./GitRollbackControls";

const noop = () => {};
const entry = (path: string, indexStatus = " ", worktreeStatus = "M"): GitStatusEntry => ({ path, indexStatus, worktreeStatus });

describe("Git rollback controls", () => {
  it("places Rollback Selected immediately before Push and disables it without a selection", () => {
    const markup = renderToStaticMarkup(<GitToolbarActions selectedCount={0} operationRunning={false} pushing={false} fetching={false} rollingBack={false} onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(markup.indexOf("Rollback Selected")).toBeLessThan(markup.indexOf('aria-label="Push"'));
    expect(markup).toMatch(/aria-label="Rollback Selected"[^>]*disabled/);
  });

  it("disables every toolbar operation while a Git operation is running", () => {
    const markup = renderToStaticMarkup(<GitToolbarActions selectedCount={2} operationRunning pushing={false} fetching={false} rollingBack onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(markup.match(/disabled/g)).toHaveLength(4);
    expect(markup).toContain("status-toast-spinner");
  });

  it("shows an accessible ahead badge only for unpushed commits", () => {
    const ahead = renderToStaticMarkup(<GitToolbarActions selectedCount={0} operationRunning={false} pushing={false} fetching={false} rollingBack={false} upstream={{ upstream: "origin/main", ahead: 2, behind: 1, lastFetch: "2026-08-30T10:00:00.000Z" }} onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(ahead).toContain('aria-label="Push 2 unpushed commits"');
    expect(ahead).toContain('class="git-push-badge"');
    expect(ahead).toContain("2 commits ahead of origin/main");
    expect(ahead).toContain('aria-label="Fetch remote changes; 1 commit behind"');
    const synchronized = renderToStaticMarkup(<GitToolbarActions selectedCount={0} operationRunning={false} pushing={false} fetching={false} rollingBack={false} upstream={{ upstream: "origin/main", ahead: 0, behind: 0 }} onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(synchronized).not.toContain("git-push-badge");
    expect(synchronized).toContain("up to date with origin/main");
  });

  it("distinguishes a branch without an upstream without showing an ahead indicator", () => {
    const markup = renderToStaticMarkup(<GitToolbarActions selectedCount={0} operationRunning={false} pushing={false} fetching={false} rollingBack={false} onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(markup).not.toContain("git-push-badge");
    expect(markup).toContain("branch is not published");
  });

  it("makes an in-progress fetch visibly cancellable", () => {
    const markup = renderToStaticMarkup(<GitToolbarActions selectedCount={0} operationRunning fetching pushing={false} rollingBack={false} upstream={{ upstream: "origin/main", ahead: 0, behind: 0 }} onRollbackSelected={noop} onPush={noop} onFetch={noop} onRefresh={noop} />);
    expect(markup).toContain('aria-label="Cancel Git fetch"');
    expect(markup).toContain("status-toast-spinner");
  });

  it("rejects Git status that completed after a task workspace switch", () => {
    expect(shouldApplyGitStatus(4, 4, "/tasks/old", "/tasks/new")).toBe(false);
    expect(shouldApplyGitStatus(3, 4, "/tasks/new", "/tasks/new")).toBe(false);
    expect(shouldApplyGitStatus(4, 4, "/tasks/new", "/tasks/new")).toBe(true);
  });

  it("targets only entries whose paths are selected", () => {
    expect(selectedGitEntries([entry("selected.ts"), entry("untouched.ts"), entry("staged.ts", "M", " ")], new Set(["selected.ts", "staged.ts"])).map((item) => item.path)).toEqual(["selected.ts", "staged.ts"]);
  });

  it("sends only selected paths and refreshes status after a partial success", async () => {
    const requested: string[][] = [];
    let refreshes = 0;
    const result = await executeRollbackSelection([entry("selected.ts"), entry("fails.ts", "M", " ")], false, async (paths) => {
      requested.push(paths); return { rolledBack: ["selected.ts"], failures: [{ path: "fails.ts", message: "locked" }] };
    }, async () => { refreshes += 1; });
    expect(requested).toEqual([["selected.ts", "fails.ts"]]);
    expect(refreshes).toBe(1);
    expect(result.failures).toEqual([{ path: "fails.ts", message: "locked" }]);
  });

  it("does not refresh status when every selected rollback fails", async () => {
    let refreshes = 0;
    await executeRollbackSelection([entry("fails.ts")], false, async () => ({ rolledBack: [], failures: [{ path: "fails.ts", message: "locked" }] }), async () => { refreshes += 1; });
    expect(refreshes).toBe(0);
  });

  it("lists affected paths, offers cancel, and explicitly gates untracked deletion", () => {
    const markup = renderToStaticMarkup(<RollbackSelectedDialog entries={[entry("tracked.ts"), entry("notes.txt", "?", "?")]} busy={false} onClose={noop} onConfirm={noop} />);
    expect(markup).toContain("tracked.ts");
    expect(markup).toContain("notes.txt");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("1 untracked, will be permanently deleted");
    expect(markup).toMatch(/class="danger"[^>]*disabled/);
  });

  it("allows tracked staged and unstaged rollback without an extra deletion acknowledgement", () => {
    const markup = renderToStaticMarkup(<RollbackSelectedDialog entries={[entry("partial.ts", "M", "M"), entry("deleted.ts", "D", " ")]} busy={false} onClose={noop} onConfirm={noop} />);
    expect(markup).not.toContain("permanently deleted");
    expect(markup).not.toMatch(/class="danger"[^>]*disabled/);
  });
});
