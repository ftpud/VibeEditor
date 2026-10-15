import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** Read credentials through the main process without persisting them as UI settings. */
export async function connectionToken(
  host: unknown,
  port: unknown,
  target?: { host?: string; port?: string },
): Promise<string | undefined> {
  if (typeof host !== "string" || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid Core connection target");
  const launchTarget = validateLaunchTarget(target);
  const explicitToken = process.env.REMOTE_IDE_SESSION_TOKEN;
  const explicitTokenFile = process.env.REMOTE_IDE_SESSION_TOKEN_FILE;
  if ((explicitToken || explicitTokenFile) && launchTarget && !sameTarget(host, Number(port), launchTarget.host, launchTarget.port)) {
    throw new Error("Configured Core session credential does not match the launch target");
  }
  if (explicitToken) return explicitToken;
  let file = explicitTokenFile;
  if (!file && (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host))) file = path.join(os.homedir(), ".remote-ide", "core-tokens", `${port}.token`);
  if (!file) return undefined;
  try { return (await readFile(file, "utf8")).trim(); }
  catch (error) { if (!process.env.REMOTE_IDE_SESSION_TOKEN_FILE && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function validateLaunchTarget(target?: { host?: string; port?: string }): { host: string; port: number } | undefined {
  if (target === undefined) return undefined;
  if (!target || typeof target !== "object") throw new Error("Invalid Core launch target");
  const { host, port } = target;
  // Gateway launch options can intentionally specify only one side; without
  // both values there is no complete target to bind the credential to.
  if (host === undefined || port === undefined) return undefined;
  if (typeof host !== "string" || host.length === 0 || typeof port !== "string" || !/^\d+$/.test(port)) {
    throw new Error("Invalid Core launch target");
  }
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error("Invalid Core launch target");
  return { host, port: numericPort };
}

function sameTarget(host: string, port: number, launchHost: string, launchPort: number): boolean {
  return port === launchPort && comparableHost(host) === comparableHost(launchHost);
}

/** Hostnames are case-insensitive; bracketed and unbracketed IPv6 literals match. */
function comparableHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}
