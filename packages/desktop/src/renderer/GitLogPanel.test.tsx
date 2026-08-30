import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagGroup } from "./GitLogPanel";

afterEach(cleanup);

describe("TagGroup", () => {
  const tags = [{ name: "v1.0.0", target: "a".repeat(40), annotated: false }];

  it("labels tag effects as local and selects a tag for history browsing", () => {
    const onSelect = vi.fn();
    render(<TagGroup tags={tags} selected="" disabled={false} onSelect={onSelect} onCreate={vi.fn()} onContextMenu={vi.fn()} />);
    expect(screen.getByText("Create/delete affects this local repository only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /v1\.0\.0/ }));
    expect(onSelect).toHaveBeenCalledWith("v1.0.0");
  });

  it("does not enable local tag creation until a commit is selected", () => {
    render(<TagGroup tags={[]} selected="" disabled={true} onSelect={vi.fn()} onCreate={vi.fn()} onContextMenu={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Create local tag" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
