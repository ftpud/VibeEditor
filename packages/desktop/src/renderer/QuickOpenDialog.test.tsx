import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "@remote-ide/protocol";
import { QuickOpenDialog, rankQuickOpenFiles, workspaceFiles } from "./QuickOpenDialog";

const tree: FileTreeNode[] = [
  { name: "src", path: "src", type: "directory", children: [
    { name: "components", path: "src/components", type: "directory", children: [{ name: "ProjectTree.tsx", path: "src/components/ProjectTree.tsx", type: "file" }] },
    { name: "quick-project.ts", path: "src/quick-project.ts", type: "file" }
  ] },
  { name: "README.md", path: "README.md", type: "file" }
];

afterEach(cleanup);

describe("Quick Open matching", () => {
  it("flattens Core-owned tree files and ranks filename prefixes above loose path matches", () => {
    const files = workspaceFiles(tree);
    expect(files.map((file) => file.path)).toEqual(["src/components/ProjectTree.tsx", "src/quick-project.ts", "README.md"]);
    expect(rankQuickOpenFiles(files, "pro").map((file) => file.path)).toEqual(["src/components/ProjectTree.tsx", "src/quick-project.ts"]);
  });

  it("supports case-insensitive subsequence matching and excludes non-matches", () => {
    expect(rankQuickOpenFiles(workspaceFiles(tree), "PTX").map((file) => file.path)).toEqual(["src/components/ProjectTree.tsx"]);
  });
});

describe("QuickOpenDialog keyboard interaction", () => {
  it("navigates, opens the active file, and closes with Escape", () => {
    const onOpen = vi.fn(); const onClose = vi.fn();
    render(<QuickOpenDialog files={workspaceFiles(tree)} onOpen={onOpen} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: "Search workspace files" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "src" } });
    const list = screen.getByRole("listbox", { name: "Workspace files" });
    expect(within(list).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "src/components/ProjectTree.tsx" }));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows explicit workspace-empty and no-match states", () => {
    const { rerender } = render(<QuickOpenDialog files={[]} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No files in this workspace")).toBeTruthy();
    rerender(<QuickOpenDialog files={workspaceFiles(tree)} onOpen={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "missing-file" } });
    expect(screen.getByText("No files match “missing-file”")).toBeTruthy();
  });
});
