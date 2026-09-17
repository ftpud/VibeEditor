import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker cost information", () => {
  it("shows the cost tier without presenting it as an efficiency score", () => {
    render(<ModelPicker models={[{ id: "expensive", name: "Expensive", price: "15x", priceTier: "high", defaultReasoning: "", reasoningLevels: [] }]} value="expensive" label="Model" onChange={vi.fn()} />);
    expect(screen.getByText("High cost · 15× legacy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText(/applies only to legacy request-based Copilot plans/)).toBeTruthy();
    expect(screen.getAllByText("High cost · 15× legacy")[1]?.getAttribute("title")).toContain("Current AI Credit usage depends on tokens");
  });
});
