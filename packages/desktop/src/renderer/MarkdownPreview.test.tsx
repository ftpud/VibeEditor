import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownPreview, resolveMarkdownLink, toggleMarkdownTask } from "./MarkdownPreview";

afterEach(cleanup);

describe("resolveMarkdownLink", () => {
  it("resolves relative and workspace-root paths without allowing workspace escapes", () => {
    expect(resolveMarkdownLink("../guide.md#setup", "docs/reference/readme.md")).toEqual({ type: "file", path: "docs/guide.md" });
    expect(resolveMarkdownLink("/README.md", "docs/readme.md")).toEqual({ type: "file", path: "README.md" });
    expect(resolveMarkdownLink("../../../outside.md", "docs/readme.md")).toEqual({ type: "unsupported" });
  });

  it("accepts only HTTP(S) external links", () => {
    expect(resolveMarkdownLink("https://example.com/docs?q=1", "README.md")).toEqual({ type: "external", url: "https://example.com/docs?q=1" });
    expect(resolveMarkdownLink("mailto:user@example.com", "README.md")).toEqual({ type: "unsupported" });
    expect(resolveMarkdownLink("javascript:alert(1)", "README.md")).toEqual({ type: "unsupported" });
  });

  it("maps file URLs inside the workspace and rejects files outside it", () => {
    expect(resolveMarkdownLink("file:///work/project/docs/guide.md", "README.md", "/work/project")).toEqual({ type: "file", path: "docs/guide.md" });
    expect(resolveMarkdownLink("file:///work/other/secret.md", "README.md", "/work/project")).toEqual({ type: "unsupported" });
  });
});

describe("MarkdownPreview task checkboxes", () => {
  it("updates the source marker when a task is clicked", () => {
    const onChange = vi.fn();
    render(<MarkdownPreview sourcePath="README.md" onOpenFile={vi.fn()} onOpenExternal={vi.fn()} onChange={onChange}>{"- [ ] First\n- [x] Second"}</MarkdownPreview>);

    const boxes = screen.getAllByRole<HTMLInputElement>("checkbox");
    expect(boxes[0]!.disabled).toBe(false);
    fireEvent.click(boxes[0]!);
    expect(onChange).toHaveBeenCalledWith("- [x] First\n- [x] Second");
  });

  it("only changes the task marker on the selected source line", () => {
    expect(toggleMarkdownTask("- [ ] parent\n  1. [X] nested", 1, false)).toBe("- [ ] parent\n  1. [ ] nested");
  });
});

describe("MarkdownPreview link clicks", () => {
  it("opens relative files in the editor without navigating the renderer", () => {
    const openFile = vi.fn();
    const openExternal = vi.fn();
    render(<MarkdownPreview sourcePath="docs/readme.md" onOpenFile={openFile} onOpenExternal={openExternal}>[Guide](../guide.md)</MarkdownPreview>);

    const link = screen.getByRole("link", { name: "Guide" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(openFile).toHaveBeenCalledWith("guide.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("sends HTTP(S) links to the external opener and blocks unsupported protocols", () => {
    const openFile = vi.fn();
    const openExternal = vi.fn();
    render(<MarkdownPreview sourcePath="README.md" onOpenFile={openFile} onOpenExternal={openExternal}>[Web](https://example.com/path) [Unsafe](javascript:alert(1))</MarkdownPreview>);

    const webClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    const unsafeClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Web" }).dispatchEvent(webClick);
    screen.getByText("Unsafe").dispatchEvent(unsafeClick);

    expect(webClick.defaultPrevented).toBe(true);
    expect(unsafeClick.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("routes file URLs within the active workspace to the editor", () => {
    const openFile = vi.fn();
    render(<MarkdownPreview sourcePath="README.md" workspacePath="/work/project" onOpenFile={openFile} onOpenExternal={vi.fn()}>[File](file:///work/project/src/app.ts)</MarkdownPreview>);

    fireEvent.click(screen.getByRole("link", { name: "File" }));
    expect(openFile).toHaveBeenCalledWith("src/app.ts");
  });
});
