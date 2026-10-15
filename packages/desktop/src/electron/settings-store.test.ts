import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "./settings-store.js";

it("restores client layout choices from disk after shutdown and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-layout-settings-"));
  try {
    const file = path.join(directory, "settings.json");
    const client = new SettingsStore(file);
    const choices = { sideLayout: "classic", focusMode: "true", "focusDock.left": "auto-hide", "focusDock.right": "pinned", "focusDock.bottom": "bubble" };
    for (const [key, value] of Object.entries(choices)) client.set(key, value);
    // App shutdown flushes the pending settings write before the process exits.
    client.flush();
    const restarted = new SettingsStore(file);
    expect(restarted.all()).toEqual(choices);
    restarted.set("focusMode", "false");
    restarted.set("focusDock.bottom", "auto-hide");
    restarted.flush();
    expect(new SettingsStore(file).all()).toEqual({ ...choices, focusMode: "false", "focusDock.bottom": "auto-hide" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
