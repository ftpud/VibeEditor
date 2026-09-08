import { useEffect, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { ConflictCompareEditor } from "./ConflictCompareEditor";

vi.mock("@monaco-editor/react", () => ({ default: function MockEditor({ value, onChange, onMount, options }: { value: string; onChange?(value: string): void; onMount(instance: unknown): void; options: { ariaLabel: string; readOnly: boolean } }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onMount({
      onDidScrollChange: () => ({ dispose() {} }),
      getModel: () => ({ getLineCount: () => 100 }),
      addGlyphMarginWidget: (widget: editor.IGlyphMarginWidget) => host.current?.appendChild(widget.getDomNode()),
      removeGlyphMarginWidget: (widget: editor.IGlyphMarginWidget) => widget.getDomNode().remove(),
      createDecorationsCollection: () => ({ clear() {} })
    });
  }, []);
  return <div><textarea aria-label={options.ariaLabel} readOnly={options.readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} /><div ref={host} /></div>;
} }));
afterEach(cleanup);
const base = "a\nseparator\nb\n";
function Harness() {
  const [result, setResult] = useState(base);
  return <ConflictCompareEditor path="file.ts" base={base} ours={"ours\nseparator\nB\n"} theirs={"theirs\nseparator\nb\n"} result={result} language="typescript" busy={false} onChange={setResult} />;
}
describe("ConflictCompareEditor", () => {
  it("shows three panes and applies automatic changes and individual blocks into the right pane", () => {
    render(<Harness />);
    expect(screen.getAllByRole("textbox").map((node) => node.getAttribute("aria-label"))).toEqual(["ours for file.ts", "theirs for file.ts", "Resolution result for file.ts"]);
    fireEvent.click(screen.getByRole("button", { name: "Merge non-conflicting changes" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("a\nseparator\nB\n");
    fireEvent.click(screen.getByRole("button", { name: "Apply theirs block 1 to result" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("theirs\nseparator\nB\n");
    fireEvent.click(screen.getByRole("button", { name: "Apply ours block 1 to result" }));
    expect((screen.getByRole("textbox", { name: "Resolution result for file.ts" }) as HTMLTextAreaElement).value).toBe("ours\nseparator\nB\n");
  });
});
