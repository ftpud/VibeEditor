import { describe, expect, it, vi } from "vitest";
import { installGatewayWindowChrome } from "./window-chrome";

describe("Gateway native window chrome", () => {
  it.each([["darwin", "mac"], ["win32", "windows"], ["linux", "linux"]])("reserves controls for %s and tracks entering and leaving fullscreen", (platform, expected) => {
    const root = document.createElement("div");
    const remove = vi.fn();
    let update!: (fullscreen: boolean) => void;
    const dispose = installGatewayWindowChrome(root, { platform, onFullscreenChange: (listener) => { update = listener; return remove; } });
    expect(root.dataset.nativeWindow).toBe("true");
    expect(root.dataset.platform).toBe(expected);
    expect(root.dataset.fullscreen).toBe("false");
    update(true);
    expect(root.dataset.fullscreen).toBe("true");
    update(false);
    expect(root.dataset.fullscreen).toBe("false");
    dispose();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("runs in browser previews without reserving native window controls", () => {
    const root = document.createElement("div");
    const dispose = installGatewayWindowChrome(root);
    expect(root.dataset.nativeWindow).toBe("false");
    expect(() => dispose()).not.toThrow();
  });
});
