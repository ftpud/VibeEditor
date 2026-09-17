import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchSelectorGroup } from "./App.js";

type Branch = { name: string; current: boolean; remote: boolean };

function Selector({ branches }: { branches: Branch[] }) {
  const [selected, setSelected] = useState<string>();
  return <BranchSelectorGroup title="Branches" branches={branches} selected={selected} onSelect={setSelected} onCheckout={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onPublish={vi.fn()} onSetUpstream={vi.fn()} />;
}

function openBranch(...segments: string[]) {
  for (const segment of segments) fireEvent.click(screen.getByText(segment).closest("button")!);
}

describe("BranchSelectorGroup", () => {
  afterEach(cleanup);

  it("reveals local lifecycle actions after expanding and selecting a nested branch", () => {
    render(<Selector branches={[{ name: "feature/demo", current: false, remote: false }]} />);
    openBranch("feature", "demo");
    expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upstream" })).toBeTruthy();
  });

  it("reveals only remote deletion among lifecycle actions after navigating its hierarchy", () => {
    render(<Selector branches={[{ name: "origin/feature/demo", current: false, remote: true }]} />);
    openBranch("origin", "feature", "demo");
    expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upstream" })).toBeNull();
  });
});
