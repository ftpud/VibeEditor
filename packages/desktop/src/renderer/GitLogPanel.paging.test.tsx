import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCommit } from "@remote-ide/protocol";
import { GitLogPanel } from "./GitLogPanel";
import type { CoreClient } from "./client";

afterEach(cleanup);
const history = (count: number): GitCommit[] => Array.from({ length: count }, (_, index) => ({ hash: index.toString(16).padStart(40, "0"), shortHash: `c${index}`, subject: `Commit ${index}`, author: "Dev", date: "2026-01-01", parents: index + 1 < count ? [(index + 1).toString(16).padStart(40, "0")] : [] }));
it("loads older commits on demand and reloads after outside repository changes", async () => {
  let all = history(450);
  const request = vi.fn(async (type: string, payload: { limit?: number; skip?: number }) => {
    if (type === "git.branches") return { branches: [{ name: "main", current: true, remote: false }] };
    if (type === "git.tags") return { tags: [] };
    if (type === "git.log") { const skip = payload.skip ?? 0; const limit = payload.limit ?? 200; return { commits: all.slice(skip, skip + limit), hasMore: skip + limit < all.length }; }
    throw new Error(type);
  });
  const view = render(<GitLogPanel client={{ request } as unknown as CoreClient} height={400} onResizeStart={vi.fn()} />);
  await screen.findByRole("button", { name: /Commit 199/ });
  expect(screen.queryByRole("button", { name: /Commit 200/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more commits" }));
  await screen.findByRole("button", { name: /Commit 399/ });
  expect(request).toHaveBeenCalledWith("git.log", { branch: "main", limit: 200, skip: 200 });
  fireEvent.click(screen.getByRole("button", { name: "Load more commits" }));
  await screen.findByText("Beginning of history · 450 commits");
  // A commit made outside Vibe: the panel reloads from the top and keeps what was loaded.
  all = [{ hash: "f".repeat(40), shortHash: "new", subject: "Outside commit", author: "Dev", date: "2026-01-02", parents: [all[0]!.hash] }, ...all];
  view.rerender(<GitLogPanel client={{ request } as unknown as CoreClient} height={400} revision={1} onResizeStart={vi.fn()} />);
  await screen.findByRole("button", { name: /Outside commit/ });
  expect(request).toHaveBeenLastCalledWith("git.log", { branch: "main", limit: 450 });
  await waitFor(() => expect(screen.getAllByRole("button", { name: /Commit \d+ c\d+/ })).toHaveLength(449));
});
