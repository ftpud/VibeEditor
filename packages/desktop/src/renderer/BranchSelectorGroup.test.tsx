import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPicker } from "./BranchPicker";

const branches = [
  { name: "main", current: true, remote: false },
  { name: "feature/demo", current: false, remote: false },
  { name: "origin/feature/demo", current: false, remote: true },
];
function setup() {
  const props = { current: "main", menu: { branches, loading: false }, onToggle: vi.fn(), onClose: vi.fn(), onRefresh: vi.fn(), onCreate: vi.fn(), onCheckout: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onPublish: vi.fn(), onSetUpstream: vi.fn() };
  render(<BranchPicker {...props} />);
  return props;
}
afterEach(cleanup);
describe("branch switching", () => {
  it("checks out a full branch name directly without expanding its path or an action menu", () => {
    const props = setup();
    fireEvent.click(screen.getByTitle("Checkout feature/demo"));
    expect(props.onCheckout).toHaveBeenCalledWith(branches[1]);
  });
  it("filters by full branch path and separates remote branches", () => {
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a branch" }), { target: { value: "feature/demo" } });
    expect(screen.queryByTitle("Current branch: main")).toBeNull();
    expect(screen.getByTitle("Checkout feature/demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Remote/ }));
    expect(screen.queryByTitle("Checkout feature/demo")).toBeNull();
    expect(screen.getByTitle("Checkout origin/feature/demo")).toBeTruthy();
  });
  it("keeps branch management separate from checkout and protects the current branch", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for main" }));
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for feature/demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(props.onRename).toHaveBeenCalledWith(branches[1]);
    fireEvent.click(screen.getByRole("tab", { name: /Remote/ }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for origin/feature/demo" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
  it("supports arrow navigation, Escape dismissal, and restoring focus to its trigger", () => {
    const props = setup();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find a branch" }), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTitle("Current branch: main"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTitle("Checkout feature/demo"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Git branches" }));
  });
});
