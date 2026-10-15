import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreError } from "./errors.js";

export type CoreAccessOptions = { token?: string; allowedOrigins?: string[] };
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.(?:\d{1,3})){3}$/.test(host);
}
export function coreAccessPolicy(host: string, options: CoreAccessOptions = {}) {
  if (options.token !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error("Core session token must contain 32–256 URL-safe characters");
  if (!options.token && !isLoopbackHost(host)) throw new Error("Non-loopback Core listeners require session authentication");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  return {
    allowsOrigin(origin: string | undefined): boolean {
      // Native clients omit Origin. Packaged Electron documents have an opaque
      // origin, and still must authenticate in the protocol handshake.
      return origin === undefined || ((origin === "null" || origin === "file://") && Boolean(options.token)) || allowedOrigins.has(origin);
    },
    authenticate(value: unknown): void {
      if (!options.token) return;
      if (typeof value !== "string" || Buffer.byteLength(value) !== Buffer.byteLength(options.token) || !timingSafeEqual(Buffer.from(value), Buffer.from(options.token))) {
        throw new CoreError("INVALID_REQUEST", "Core authentication failed. Launch Desktop through Gateway or configure its Core session token.");
      }
    },
  };
}

/** Shared by direct local Core/Desktop launches; Gateway may supply its own file. */
export function defaultCoreTokenFile(port: number): string {
  return path.join(os.homedir(), ".remote-ide", "core-tokens", `${port}.token`);
}

export async function loadCoreSessionToken(port: number, environment = process.env): Promise<{ token: string; file?: string }> {
  if (environment.REMOTE_IDE_SESSION_TOKEN) {
    coreAccessPolicy("127.0.0.1", { token: environment.REMOTE_IDE_SESSION_TOKEN });
    return { token: environment.REMOTE_IDE_SESSION_TOKEN };
  }
  const file = environment.REMOTE_IDE_SESSION_TOKEN_FILE || defaultCoreTokenFile(port);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString("hex")}\n`); await handle.sync(); }
    finally { await handle.close(); }
    // Hard-link publication is exclusive and exposes only complete token files.
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => undefined); }
  const info = await lstat(file);
  if (!info.isFile() || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new Error(`Core token file must be a private regular file owned by this user: ${file}`);
  const token = (await readFile(file, "utf8")).trim();
  coreAccessPolicy("127.0.0.1", { token });
  return { token, file };
}
