type WindowChromeBridge = Pick<Window["gateway"], "platform" | "onFullscreenChange">;

/** Native controls occupy the page's padding, with that space reclaimed in fullscreen. */
export function installGatewayWindowChrome(root: HTMLElement, bridge?: WindowChromeBridge): () => void {
  root.dataset.nativeWindow = String(Boolean(bridge));
  const platform = bridge?.platform ?? (navigator.platform.toLowerCase().includes("mac") ? "darwin" : navigator.platform.toLowerCase().includes("win") ? "win32" : "linux");
  root.dataset.platform = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  root.dataset.fullscreen = "false";
  return bridge?.onFullscreenChange?.((fullscreen) => { root.dataset.fullscreen = String(fullscreen); }) ?? (() => undefined);
}
