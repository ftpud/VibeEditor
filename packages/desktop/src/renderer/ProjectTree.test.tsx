import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "@remote-ide/protocol";
import { ProjectTree, filterProjectTree } from "./ProjectTree";

const nodes: FileTreeNode[] = [{
  name: "src", path: "src", type: "directory", children: [
    { name: "components", path: "src/components", type: "directory", children: [{ name: "Tree.tsx", path: "src/components/Tree.tsx", type: "file" }] },
    { name: "main.ts", path: "src/main.ts", type: "file" }
  ]
}, { name: "README.md", path: "README.md", type: "file" }];

afterEach(cleanup);

function renderTree(options: { query?: string; activePath?: string } = {}) {
  const onOpen = vi.fn();
  render(<ProjectTree nodes={nodes} query={options.query ?? ""} activePath={options.activePath} fileColors={{}} gitStatuses={{}} onOpen={onOpen} onContextMenu={vi.fn()} />);
  return onOpen;
}

describe("ProjectTree", () => {
  it("supports expanding all and collapsing all folders", () => {
    renderTree();
    expect(screen.queryByText("Tree.tsx")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand all folders" }));
    expect(screen.getByText("Tree.tsx")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));
    expect(screen.queryByText("main.ts")).toBeNull();
  });

  it("navigates visible rows with arrows and opens a file with Enter", () => {
    const onOpen = renderTree();
    const src = screen.getByRole("treeitem", { name: "src" });
    fireEvent.focus(src);
    fireEvent.keyDown(src, { key: "ArrowRight" });
    fireEvent.keyDown(src, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "components" }));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "main.ts" }));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "src/main.ts" }));
  });

  it("reveals the active file and reports filtered file counts", async () => {
    renderTree({ activePath: "src/components/Tree.tsx" });
    expect(await screen.findByText("Tree.tsx")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: "Tree.tsx" }).getAttribute("tabindex")).toBe("-1");
  });

  it("keeps matching ancestor context while filtering", () => {
    expect(filterProjectTree(nodes, "tree.tsx")).toEqual([expect.objectContaining({
      path: "src",
      children: [expect.objectContaining({ path: "src/components", children: [expect.objectContaining({ path: "src/components/Tree.tsx" })] })]
    })]);
    renderTree({ query: "tree.tsx" });
    expect(screen.getByText("1 matching file")).not.toBeNull();
    expect(screen.getByText("Tree.tsx")).not.toBeNull();
  });
});
