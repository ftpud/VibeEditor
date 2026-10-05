import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsMenu } from "./SettingsMenu";

afterEach(cleanup);

const values = { theme: "dark" as const, highlightTheme: "default" as const, uiFontFamily: "jetbrains" as const, uiFontWeight: 450, uiFontSize: 13, uiLineHeight: 1.2 };
const shortcutProps = { commands: [], shortcutBindings: {}, platform: "linux" as const, onShortcutChange: vi.fn(), onShortcutsReset: vi.fn() };

describe("SettingsMenu", () => {
  it("filters persisted desktop settings", () => {
    render(<SettingsMenu {...shortcutProps} workspace="/project" sideLayout="classic" onSideLayoutChange={vi.fn()} values={values} isWorkspaceOverride={() => false} onChange={vi.fn()} onReset={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "font" } });
    expect(screen.getByText("Font")).toBeTruthy();
    expect(screen.queryByText("Theme")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "nothing" } });
    expect(screen.getByText("No desktop settings match “nothing”.")).toBeTruthy();
  });

  it("labels overrides and resets them to the global default", () => {
    const onReset = vi.fn();
    render(<SettingsMenu {...shortcutProps} workspace="/project" sideLayout="classic" onSideLayoutChange={vi.fn()} values={values} isWorkspaceOverride={(setting) => setting === "theme"} onChange={vi.fn()} onReset={onReset} />);
    expect(screen.getAllByText("Workspace override")).toHaveLength(1);
    expect(screen.getAllByText("Global default")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledWith("theme");
  });

  it("offers one ftpud choice whose palette follows the selected theme", () => {
    const onChange = vi.fn();
    const view = render(<SettingsMenu {...shortcutProps} workspace="/project" sideLayout="classic" onSideLayoutChange={vi.fn()} values={values} isWorkspaceOverride={() => false} onChange={onChange} onReset={vi.fn()} />);
    const button = [...view.container.querySelectorAll("button")].find((item) => item.textContent === "Ftpud");
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    expect(onChange).toHaveBeenCalledWith("highlightTheme", "ftpud");
    expect([...view.container.querySelectorAll("button")].some((item) => item.textContent === "Ftpud Dark")).toBe(false);
  });
});

it("changes UI font weight and clamps it to the supported range", () => {
  const onChange = vi.fn();
  render(<SettingsMenu {...shortcutProps} workspace="/project" sideLayout="classic" onSideLayoutChange={vi.fn()} values={values} isWorkspaceOverride={() => false} onChange={onChange} onReset={vi.fn()} />);
  const input = screen.getByRole("spinbutton", { name: "Font weight" });
  fireEvent.change(input, { target: { value: "500" } });
  expect(onChange).toHaveBeenLastCalledWith("uiFontWeight", 500);
  fireEvent.change(input, { target: { value: "950" } });
  expect(onChange).toHaveBeenLastCalledWith("uiFontWeight", 600);
});
