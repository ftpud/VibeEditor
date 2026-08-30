import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SearchResult } from "@remote-ide/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreClient } from "./client";
import { FindInFilesDialog } from "./FindInFilesDialog";

vi.mock("@monaco-editor/react", () => ({ default: ({ value }: { value: string }) => <div data-testid="preview-editor">{value}</div> }));
vi.mock("./theme", () => ({ configureMonacoThemes: vi.fn(), monacoTheme: () => "vs-dark" }));

const longSegment = "component-with-an-extremely-long-unbroken-name-that-must-never-expand-the-dialog";
const matches: SearchResult[] = Array.from({ length: 80 }, (_, index) => ({
  path: `packages/desktop/src/renderer/features/deeply/nested/${longSegment}-${index}.tsx`,
  line: index + 1,
  column: 123456,
  preview: `${longSegment.repeat(3)}-${index}`
}));

function clientWith(searchResult: { matches: SearchResult[]; truncated: boolean } = { matches, truncated: true }): CoreClient {
  return {
    request: vi.fn((type: string, payload: { path?: string }) => type === "filesystem.search"
      ? Promise.resolve(searchResult)
      : Promise.resolve({ content: `preview:${payload.path}` }))
  } as unknown as CoreClient;
}

async function search(query = "needle"): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: "Text to find" }), { target: { value: query } });
  await act(async () => {
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("FindInFilesDialog responsive result layout", () => {
  it("keeps loading status and controls accessible while a search is pending", () => {
    const pendingClient = { request: vi.fn(() => new Promise(() => undefined)) } as unknown as CoreClient;
    render(<FindInFilesDialog client={pendingClient} scope="src" onClose={vi.fn()} onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text to find" }), { target: { value: "needle" } });
    act(() => vi.advanceTimersByTime(600));

    expect(screen.getByRole("checkbox", { name: "Match case" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Searching...");
    expect(screen.getByRole("region", { name: "Search results" }).getAttribute("aria-busy")).toBe("true");
  });

  it("groups results by file while containing long metadata and match context", async () => {
    const scope = `workspace/${longSegment.repeat(3)}`;
    render(<FindInFilesDialog client={clientWith()} scope={scope} onClose={vi.fn()} onNavigate={vi.fn()} />);
    await search(longSegment);

    const dialog = screen.getByRole("dialog", { name: "Find in Files" });
    expect(dialog.parentElement?.classList.contains("find-dialog-overlay")).toBe(true);
    expect(within(dialog).getByTitle(scope).textContent).toBe(scope);
    expect(within(dialog).getByText("80 matches")).toBeTruthy();
    expect(within(dialog).getByText("First 500").classList.contains("find-pane-meta")).toBe(true);

    const results = within(dialog).getByRole("region", { name: "Search results" });
    const groups = results.querySelectorAll<HTMLElement>(".find-result-group");
    expect(groups).toHaveLength(80);
    const firstGroup = groups[0]!;
    const [groupHeader, resultButton] = within(firstGroup).getAllByRole("button");
    expect(groupHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(resultButton?.getAttribute("title")).toBe(matches[0]!.path);
    expect(resultButton?.getAttribute("aria-label")).toBe(`${matches[0]!.path}, line 1, column 123456`);
    expect(within(firstGroup).getByTitle(`${longSegment}-0.tsx`).classList.contains("find-result-file")).toBe(true);
    expect(within(firstGroup).getByTitle(`packages/desktop/src/renderer/features/deeply/nested`).classList.contains("find-result-path")).toBe(true);
    expect(within(resultButton!).getByTitle(matches[0]!.preview)).toBeTruthy();
    expect(within(resultButton!).getByText(longSegment).tagName).toBe("MARK");
    expect(within(results).getByText("1:123456").classList.contains("find-location")).toBe(true);
  });

  it("collapses a file group without changing the selected preview", async () => {
    const sameFileMatches = [{ ...matches[0]!, line: 1 }, { ...matches[0]!, line: 2, column: 4 }];
    render(<FindInFilesDialog client={clientWith({ matches: sameFileMatches, truncated: false })} scope="" onClose={vi.fn()} onNavigate={vi.fn()} />);
    await search();

    const group = document.querySelector<HTMLElement>(".find-result-group")!;
    const header = group.querySelector<HTMLButtonElement>(".find-result-group-header")!;
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(within(group).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("preview-editor").textContent).toBe(`preview:${matches[0]!.path}`);
  });

  it("keeps result actions usable and exposes full selected paths while metadata is visually truncated", async () => {
    const onNavigate = vi.fn();
    render(<FindInFilesDialog client={clientWith({ matches: matches.slice(0, 2), truncated: false })} scope="" onClose={vi.fn()} onNavigate={onNavigate} />);
    await search("long query");

    const results = screen.getByRole("region", { name: "Search results" });
    const second = within(results.querySelectorAll<HTMLElement>(".find-result-group")[1]!).getAllByRole("button")[1]!;
    fireEvent.click(second);
    expect(second.classList.contains("selected")).toBe(true);
    expect(document.querySelector<HTMLElement>(`.find-preview-file[title="${matches[1]!.path}"]`)?.textContent).toBe(`${longSegment}-1.tsx`);

    fireEvent.doubleClick(second);
    expect(onNavigate).toHaveBeenCalledWith(matches[1], "long query".length);
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onNavigate).toHaveBeenLastCalledWith(matches[1], "long query".length);
  });

  it("renders empty and long unbroken error states inside the dialog and retains Escape handling", async () => {
    const onClose = vi.fn();
    const emptyClient = clientWith({ matches: [], truncated: false });
    const { rerender } = render(<FindInFilesDialog client={emptyClient} scope="src" onClose={onClose} onNavigate={vi.fn()} />);
    await search();
    expect(screen.getByText("No matches").classList.contains("find-empty")).toBe(true);

    const message = `SearchFailed:${longSegment.repeat(4)}`;
    const errorClient = { request: vi.fn(() => Promise.reject(new Error(message))) } as unknown as CoreClient;
    rerender(<FindInFilesDialog client={errorClient} scope="src" onClose={onClose} onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text to find" }), { target: { value: "another" } });
    await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("alert").classList.contains("find-error")).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(message);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
