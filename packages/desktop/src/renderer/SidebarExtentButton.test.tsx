import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it("restores independent sidebar extents from durable client settings after a restart", async () => {
  const saved: Record<string, string> = {};
  const writeSetting = vi.fn((key: string, value: string) => { saved[key] = value; });
  vi.stubGlobal("desktop", { loadSettings: () => ({ ...saved }), writeSetting });
  vi.resetModules();
  const first = await import("./SidebarExtentButton");
  function Controls() {
    const [left, setLeft] = first.useSidebarExtent("left");
    const [right, setRight] = first.useSidebarExtent("right");
    return <><first.SidebarExtentButton edge="left" extended={left} onChange={setLeft} /><first.SidebarExtentButton edge="right" extended={right} onChange={setRight} /></>;
  }
  const view = render(<Controls />);
  fireEvent.click(screen.getByRole("button", { name: "Extend left sidebar to bottom" }));
  expect(screen.getByRole("button", { name: "Restore left sidebar height" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Extend right sidebar to bottom" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Extend right sidebar to bottom" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore left sidebar height" }));
  expect(writeSetting).toHaveBeenLastCalledWith("sidebar.leftExtended", "false");
  view.unmount();
  // Lose browser storage and module caches, as when the packaged client restarts.
  localStorage.clear();
  vi.resetModules();
  const restarted = await import("./SidebarExtentButton");
  function RestoredControls() {
    const [left, setLeft] = restarted.useSidebarExtent("left");
    const [right, setRight] = restarted.useSidebarExtent("right");
    return <><restarted.SidebarExtentButton edge="left" extended={left} onChange={setLeft} /><restarted.SidebarExtentButton edge="right" extended={right} onChange={setRight} /></>;
  }
  render(<RestoredControls />);
  expect(screen.getByRole("button", { name: "Extend left sidebar to bottom" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "Restore right sidebar height" }).getAttribute("aria-pressed")).toBe("true");
});
