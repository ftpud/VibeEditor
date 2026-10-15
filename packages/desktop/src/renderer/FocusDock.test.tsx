import { readSetting, removeSetting, writeSetting } from "./settings";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FocusDock } from "./FocusDock";

afterEach(() => { cleanup(); for (const edge of ["left", "right", "bottom"]) removeSetting(`focusDock.${edge}`); });
it("keeps tools mounted while the bubble reveals them on hover and folds them on leave", () => {
  render(<FocusDock active edge="left"><input aria-label="Tool draft" defaultValue="Keep this" /></FocusDock>);
  const handle = screen.getByRole("button", { name: "Left tools" });
  const content = document.getElementById(handle.getAttribute("aria-controls")!)!;
  const draft = screen.getByLabelText("Tool draft");
  expect(content.inert).toBe(true);
  fireEvent.pointerEnter(handle.parentElement!);
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  expect(content.inert).toBe(false);
  fireEvent.pointerLeave(handle.parentElement!);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByLabelText("Tool draft")).toBe(draft);
});
it("pins tools open on click and Escape folds only the dock", () => {
  const view = render(<FocusDock active edge="bottom"><button>Terminal</button></FocusDock>);
  const handle = screen.getByRole("button", { name: "Bottom tools" });
  fireEvent.click(handle);
  fireEvent.pointerLeave(handle.parentElement!);
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  expect(handle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(screen.getByText("Terminal"), { key: "Escape" });
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(handle.getAttribute("aria-pressed")).toBe("false");
  view.rerender(<FocusDock active={false} edge="bottom"><button>Terminal</button></FocusDock>);
  expect(screen.queryByRole("button", { name: "Bottom tools" })).toBeNull();
  expect(screen.getByText("Terminal").closest<HTMLDivElement>(".focus-dock-content")?.inert).toBe(false);
});
it("reveals tools for keyboard focus and collapses after focus leaves the dock", () => {
  render(<FocusDock active edge="right"><button>Project</button></FocusDock>);
  const handle = screen.getByRole("button", { name: "Right tools" });
  fireEvent.focus(handle);
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.blur(handle, { relatedTarget: screen.getByText("Project") });
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.blur(screen.getByText("Project"), { relatedTarget: document.body });
  expect(handle.getAttribute("aria-expanded")).toBe("false");
});

it.each(["left", "right", "bottom"] as const)("tucks the %s bubble and reveals it again on hover or keyboard focus", (edge) => {
  const view = render(<FocusDock active edge={edge}><input aria-label="Draft" defaultValue="Keep this" /></FocusDock>);
  const dock = document.querySelector(".focus-dock")!;
  const handle = screen.getByRole("button", { name: new RegExp(`^${edge} tools$`, "i") });
  const draft = screen.getByLabelText("Draft");
  fireEvent.click(handle);
  fireEvent.click(screen.getByRole("button", { name: `Hide ${edge} tools bubble` }));
  expect(dock.classList.contains("tucked")).toBe(true);
  // The full-size rail stays laid out while its position moves offscreen.
  expect(dock.classList.contains("auto-hide")).toBe(true);
  expect(dock.classList.contains("open")).toBe(true);
  expect(document.getElementById(handle.getAttribute("aria-controls")!)?.inert).toBe(true);
  expect(handle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.pointerEnter(dock);
  expect(dock.classList.contains("auto-hide")).toBe(true);
  expect(dock.classList.contains("tucked")).toBe(false);
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerLeave(dock);
  expect(dock.classList.contains("tucked")).toBe(true);
  expect(dock.classList.contains("open")).toBe(true);
  fireEvent.focus(handle);
  expect(dock.classList.contains("tucked")).toBe(false);
  fireEvent.blur(handle, { relatedTarget: document.body });
  expect(dock.classList.contains("tucked")).toBe(true);
  expect(screen.getByLabelText("Draft")).toBe(draft);
  view.rerender(<FocusDock active={false} edge={edge}><input aria-label="Draft" /></FocusDock>);
  view.rerender(<FocusDock active edge={edge}><input aria-label="Draft" /></FocusDock>);
  expect(dock.classList.contains("tucked")).toBe(true);
  expect(dock.classList.contains("auto-hide")).toBe(true);
});

it.each(["left", "right", "bottom"] as const)("restores the %s rail mode after the client remounts", (edge) => {
  const label = new RegExp(`^${edge} tools$`, "i");
  const first = render(<FocusDock active edge={edge}><button>Tool</button></FocusDock>);
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(readSetting(`focusDock.${edge}`)).toBe("pinned");
  first.unmount();
  const restarted = render(<FocusDock active edge={edge}><button>Tool</button></FocusDock>);
  expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: `Hide ${edge} tools bubble` }));
  expect(readSetting(`focusDock.${edge}`)).toBe("auto-hide");
  restarted.unmount();
  const hiddenRestart = render(<FocusDock active edge={edge}><button>Tool</button></FocusDock>);
  expect(document.querySelector(".focus-dock.auto-hide.tucked")).toBeTruthy();
  fireEvent.pointerEnter(document.querySelector(".focus-dock")!);
  expect(readSetting(`focusDock.${edge}`)).toBe("auto-hide");
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(readSetting(`focusDock.${edge}`)).toBe("bubble");
  hiddenRestart.unmount();
  render(<FocusDock active edge={edge}><button>Tool</button></FocusDock>);
  expect(document.querySelector(".focus-dock.auto-hide")).toBeNull();
  expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("false");
});
it("falls back to bubble mode for an invalid saved preference", () => {
  writeSetting("focusDock.left", "unknown");
  render(<FocusDock active edge="left"><button>Tool</button></FocusDock>);
  expect(screen.getByRole("button", { name: "Left tools" }).getAttribute("aria-pressed")).toBe("false");
  expect(document.querySelector(".auto-hide")).toBeNull();
});
