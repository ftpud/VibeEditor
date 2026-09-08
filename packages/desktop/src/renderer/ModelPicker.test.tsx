import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker cost information", () => {
  it("leads with efficiency and treats the multiplier as legacy guidance", () => {
    render(<ModelPicker models={[{ id: "expensive", name: "Expensive", price: "15x", priceTier: "high", defaultReasoning: "", reasoningLevels: [] }]} value="expensive" label="Model" onChange={vi.fn()} />);
    expect(screen.getByText("Low efficiency · 15×")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText(/not an AIC estimate/)).toBeTruthy();
    expect(screen.getAllByText("Low efficiency · 15×")[1]?.getAttribute("title")).toContain("Actual AIC cost depends on tokens");
  });
});
