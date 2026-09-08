import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { restoreWindowInputFocus } from "./window-focus.js";

function windowMock() {
  return { isDestroyed: () => false, isFocused: () => true, isEnabled: () => true, blurWebView: vi.fn(), webContents: { isDestroyed: () => false, focus: vi.fn() } };
}
describe("native dialog focus recovery", () => {
  it("resets renderer focus in the active owning window", () => {
    const owner = windowMock();
    restoreWindowInputFocus(owner as unknown as BrowserWindow);
    expect(owner.blurWebView).toHaveBeenCalledOnce();
    expect(owner.webContents.focus).toHaveBeenCalledOnce();
    expect(owner.blurWebView.mock.invocationCallOrder[0]).toBeLessThan(owner.webContents.focus.mock.invocationCallOrder[0]!);
  });
  it("does not steal focus from other apps, native dialogs, or destroyed windows", () => {
    for (const state of [{ isFocused: () => false }, { isEnabled: () => false }, { isDestroyed: () => true }]) {
      const owner = { ...windowMock(), ...state };
      restoreWindowInputFocus(owner as unknown as BrowserWindow);
      expect(owner.webContents.focus).not.toHaveBeenCalled();
    }
    expect(() => restoreWindowInputFocus(null)).not.toThrow();
  });
});
