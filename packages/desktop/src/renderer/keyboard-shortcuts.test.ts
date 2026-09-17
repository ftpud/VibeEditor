import { describe, expect, it } from "vitest";
import { migrateShortcutSetting, parseShortcutSetting, serializeShortcutSetting, updateShortcut } from "./keyboard-shortcuts";

describe("keyboard shortcut settings", () => {
  it("migrates the legacy command-id map and ignores unknown or invalid values", () => {
    const result = parseShortcutSetting(JSON.stringify({ "editor.save": "ctrl+shift+s", "removed.command": "Ctrl+R", "project.quickOpen": 42 }), "windows");
    expect(result["editor.save"]).toBe("Ctrl+Shift+S");
    expect(result["project.quickOpen"]).toBe("Ctrl+P");
    expect(result).not.toHaveProperty("removed.command");
    expect(JSON.parse(migrateShortcutSetting(JSON.stringify({ "editor.save": "ctrl+shift+s" }), "windows")!).version).toBe(1);
  });
  it("falls back safely for damaged and future-version settings", () => {
    expect(parseShortcutSetting("not-json", "mac")["editor.save"]).toBe("Meta+S");
    expect(parseShortcutSetting(JSON.stringify({ version: 2, bindings: { "editor.save": "Meta+X" } }), "mac")["editor.save"]).toBe("Meta+S");
  });
  it("round trips cleared bindings in the versioned format", () => {
    const bindings = updateShortcut(parseShortcutSetting(null, "linux"), "project.quickOpen");
    expect(parseShortcutSetting(serializeShortcutSetting(bindings), "linux")["project.quickOpen"]).toBeUndefined();
    expect(JSON.parse(serializeShortcutSetting(bindings)).version).toBe(1);
  });
});
