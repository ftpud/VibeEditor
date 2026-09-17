import type { BrowserWindow } from "electron";

/** Native JS dialogs can leave Chromium's input focus out of sync with its owner. */
export function restoreWindowInputFocus(owner: BrowserWindow | null): void {
  // Do not activate a background window or interfere with an open native modal.
  if (!owner || owner.isDestroyed() || !owner.isFocused() || !owner.isEnabled() || owner.webContents.isDestroyed()) return;
  owner.blurWebView();
  owner.webContents.focus();
}
