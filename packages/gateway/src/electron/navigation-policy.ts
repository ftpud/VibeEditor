import path from "node:path";
import { pathToFileURL } from "node:url";

export type IpcFrame = { url: string; isMainFrame: boolean };

/** Trust only the configured renderer document, with query/hash state allowed. */
export function isTrustedRendererUrl(candidate: string, rendererFilePath: string, devServerUrl?: string): boolean {
  let actual: URL;
  try { actual = new URL(candidate); }
  catch { return false; }
  if (actual.username || actual.password) return false;

  if (devServerUrl) {
    let configured: URL;
    try { configured = new URL(devServerUrl); }
    catch { return false; }
    if ((configured.protocol !== "http:" && configured.protocol !== "https:") || configured.username || configured.password) return false;
    return actual.origin === configured.origin && actual.pathname === configured.pathname;
  }

  if (actual.protocol !== "file:" || actual.host) return false;
  const expected = pathToFileURL(path.resolve(rendererFilePath));
  return actual.pathname === expected.pathname;
}

export function isTrustedIpcFrame(
  frame: IpcFrame | null | undefined,
  belongsToAppWindow: boolean,
  rendererFilePath: string,
  devServerUrl?: string,
): boolean {
  return Boolean(belongsToAppWindow && frame?.isMainFrame && isTrustedRendererUrl(frame.url, rendererFilePath, devServerUrl));
}
