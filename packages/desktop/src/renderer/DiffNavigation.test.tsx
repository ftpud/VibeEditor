import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffNavigation } from "./DiffNavigation";

afterEach(cleanup);

describe("DiffNavigation", () => {
  it("jumps to the previous and next differences", () => {
    const goToDiff = vi.fn();
    render(<DiffNavigation editorRef={{ current: { goToDiff } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous difference" }));
    fireEvent.click(screen.getByRole("button", { name: "Next difference" }));
    expect(goToDiff.mock.calls).toEqual([["previous"], ["next"]]);
  });
});
