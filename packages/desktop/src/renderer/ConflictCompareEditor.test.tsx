import { useEffect, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { ConflictCompareEditor } from "./ConflictCompareEditor";

const reveal = vi.hoisted(() => vi.fn());

vi.mock("@monaco-editor/react", () => ({ default: function MockEditor({ value, onChange, onMount, options }: { value: string; onChange?(value: string): void; onMount(instance: unknown): void; options: { ariaLabel: string; readOnly: boolean } }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onMount({
      onDidScrollChange: () => ({ dispose() {} }),
      getModel: () => ({ getLineCount: () => 100 }),
      revealLineInCenter: (line: number) => reveal(options.ariaLabel, line),
      addGlyphMarginWidget: (widget: editor.IGlyphMarginWidget) => host.current?.appendChild(widget.getDomNode()),
      removeGlyphMarginWidget: (widget: editor.IGlyphMarginWidget) => widget.getDomNode().remove(),
      createDecorationsCollection: () => ({ clear() {} })
    });
  }, []);
  return <div><textarea aria-label={options.ariaLabel} readOnly={options.readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} /><div ref={host} /></div>;
} }));
afterEach(() => { cleanup(); reveal.mockClear(); });
const base = "a\nseparator\nb\n";
function Harness() {
  const [result, setResult] = useState(base);
  return <ConflictCompareEditor path="file.ts" base={base} ours={"ours\nseparator\nB\n"} theirs={"theirs\nseparator\nb\n"} result={result} language="typescript" busy={false} onChange={setResult} />;
}
describe("ConflictCompareEditor", () => {
  it("shows ours > result < theirs and updates merged counts and block appearance", () => {
    render(<Harness />);
    expect(screen.getAllByRole("textbox").map((node) => node.getAttribute("aria-label"))).toEqual(["ours for file.ts", "Resolution result for file.ts", "theirs for file.ts"]);
    expect(screen.getByText("1 conflicts remaining")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge non-conflicting changes" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("a\nseparator\nB\n");
    fireEvent.click(screen.getByRole("button", { name: "Apply theirs block 1 to result" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("theirs\nseparator\nB\n");
    expect(screen.getByText("0 conflicts remaining")).toBeTruthy();
    expect(screen.getByText("2 merged / 2 blocks")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next conflict/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Replace with ours block 1 to result" }).dataset.status).toBe("merged");
    fireEvent.click(screen.getByRole("button", { name: "Replace with ours block 1 to result" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("ours\nseparator\nB\n");
  });
  it("navigates conflicts in all panes, wraps, and skips resolved blocks", () => {
    function Multiple() {
      const [result, setResult] = useState(base);
      return <ConflictCompareEditor path="file.ts" base={base} ours={"ours\nseparator\nours2\n"} theirs={"theirs\nseparator\ntheirs2\n"} result={result} language="typescript" busy={false} onChange={setResult} />;
    }
    render(<Multiple />);
    fireEvent.click(screen.getByRole("button", { name: /Next conflict/ }));
    expect(reveal).toHaveBeenCalledWith("Resolution result for file.ts", 1);
    fireEvent.click(screen.getByRole("button", { name: /Next conflict/ }));
    expect(reveal).toHaveBeenCalledWith("Resolution result for file.ts", 3);
    fireEvent.click(screen.getByRole("button", { name: /Previous conflict/ }));
    expect(screen.getByText("Block 1 · conflict")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply ours block 1 to result" }));
    fireEvent.click(screen.getByRole("button", { name: /Next conflict/ }));
    expect(screen.getByText("Block 2 · conflict")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next conflict/ }));
    expect(screen.getByText("Block 2 · conflict")).toBeTruthy();
  });
  it("requires review for manual content, invalidates review on edit, and supports panel resizing", () => {
    render(<Harness />);
    const result = screen.getByRole("textbox", { name: "Resolution result for file.ts" });
    fireEvent.change(result, { target: { value: "manual\nseparator\nb\n" } });
    expect(screen.getByText("1 need review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next conflict/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark block reviewed" }));
    expect(screen.getByText("0 need review")).toBeTruthy();
    fireEvent.change(result, { target: { value: "edited again\nseparator\nb\n" } });
    expect(screen.getByText("1 need review")).toBeTruthy();
    fireEvent.change(result, { target: { value: base } });
    expect(screen.getByText("1 conflicts remaining")).toBeTruthy();
    const separator = screen.getByRole("separator", { name: "Resize ours and result panels" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("32");
  });
});
