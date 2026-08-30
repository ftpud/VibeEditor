import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { JavaDiagnostic } from "@remote-ide/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemsPanel } from "./ProblemsPanel";

const diagnostics = [
  { path: "/workspace/src/App.java", line: 4, column: 2, severity: "error", message: "Missing symbol", source: "javac" },
  { path: "/workspace/test/AppTest.java", line: 9, column: 1, severity: "warning", message: "Unused import", source: "jdt" },
  { path: "/workspace/src/Other.java", line: 12, column: 3, severity: "warning", message: "Unchecked conversion" }
] as Array<JavaDiagnostic & { source?: string }>;

function setup(onOpen = vi.fn()) {
  render(<ProblemsPanel height={220} diagnostics={diagnostics} checking={false} onRefresh={vi.fn()} onOpen={onOpen} onResizeStart={vi.fn()} />);
  return { onOpen, list: screen.getByRole("listbox", { name: "Problems" }), filter: screen.getByRole("textbox", { name: "Filter problems" }) };
}

afterEach(cleanup);

describe("ProblemsPanel filtering", () => {
  it("filters case-insensitively by message, full path, and source", () => {
    const { filter, list } = setup();
    fireEvent.change(filter, { target: { value: "missing" } });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "apptest.java" } });
    expect(within(list).getByText("Unused import")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "JAVAC" } });
    expect(within(list).getByText("Missing symbol")).toBeTruthy();
  });

  it("shows counts and combines severity toggles with the text filter", () => {
    const { filter, list } = setup();
    const errors = screen.getByRole("button", { name: "Errors (1)" });
    const warnings = screen.getByRole("button", { name: "Warnings (2)" });
    expect(errors.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(warnings);
    expect(warnings.getAttribute("aria-pressed")).toBe("false");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "unused" } });
    expect(within(list).queryAllByRole("option")).toHaveLength(0);
  });
});

describe("ProblemsPanel keyboard navigation", () => {
  it("selects with arrows and opens the selected diagnostic with Enter", () => {
    const { list, onOpen } = setup();
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(diagnostics[1]);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(within(list).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("clears a filter on Escape without propagating that clearing action", () => {
    const { filter, list } = setup();
    const globalEscape = vi.fn();
    window.addEventListener("keydown", globalEscape);
    fireEvent.change(filter, { target: { value: "missing" } });
    fireEvent.keyDown(filter, { key: "Escape" });
    expect((filter as HTMLInputElement).value).toBe("");
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    expect(globalEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalEscape);
  });
});
