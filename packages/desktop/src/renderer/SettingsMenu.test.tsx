import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsMenu } from "./SettingsMenu";

const values = { theme: "dark" as const, highlightTheme: "default" as const, uiFontFamily: "jetbrains" as const, uiFontSize: 13, uiLineHeight: 1.2 };
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
    expect(screen.getAllByText("Global default")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledWith("theme");
  });

  it("offers the dark ftpud highlighting variant", () => {
    const onChange = vi.fn();
    render(<SettingsMenu {...shortcutProps} workspace="/project" sideLayout="classic" onSideLayoutChange={vi.fn()} values={values} isWorkspaceOverride={() => false} onChange={onChange} onReset={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ftpud Dark" }));
    expect(onChange).toHaveBeenCalledWith("highlightTheme", "ftpud-dark");
  });
});
