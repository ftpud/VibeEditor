import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { FocusModeButton } from "./FocusModeButton";

afterEach(cleanup);
function Workspace() {
  const [active, setActive] = useState(false);
  return <FocusModeButton active={active} onChange={setActive} />;
}
it("enters focus mode and restores the workspace using the same button or Escape", () => {
  render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
  expect(screen.getByRole("button", { name: "Exit focus mode" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
  fireEvent.click(screen.getByRole("button", { name: "Exit focus mode" }));
  expect(screen.getByRole("button", { name: "Enter focus mode" }).getAttribute("aria-pressed")).toBe("false");
});
it("leaves focus mode active when Escape belongs to a dialog", () => {
  render(<><Workspace /><div role="dialog">Settings</div></>);
  fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Exit focus mode" })).toBeTruthy();
});

it("uses an icon-only control with the shared workspace toolbar style", () => {
  render(<Workspace />);
  const button = screen.getByRole("button", { name: "Enter focus mode" });
  expect(button.textContent?.trim()).toBe("");
  expect(button.querySelector("svg")).toBeTruthy();
  expect(button.classList.contains("workspace-settings-button")).toBe(true);
  fireEvent.click(button);
  expect(screen.getByRole("button", { name: "Exit focus mode" }).textContent?.trim()).toBe("");
});
