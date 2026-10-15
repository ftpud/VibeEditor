import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coreAccessPolicy, loadCoreSessionToken } from "./access-policy.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const token = "a".repeat(64);

describe("Core access policy", () => {
  it("refuses unauthenticated network listeners", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.2", "example.test"]) expect(() => coreAccessPolicy(host)).toThrow("require session authentication");
    expect(() => coreAccessPolicy("127.0.0.1")).not.toThrow();
    expect(() => coreAccessPolicy("0.0.0.0", { token })).not.toThrow();
  });

  it("requires the exact token and never includes it in authentication errors", () => {
    const policy = coreAccessPolicy("127.0.0.1", { token });
    expect(() => policy.authenticate(token)).not.toThrow();
    for (const input of [undefined, null, {}, "", "a".repeat(63), "b".repeat(64)]) {
      expect(() => policy.authenticate(input)).toThrow("Core authentication failed");
      try { policy.authenticate(input); } catch (error) { expect(String(error)).not.toContain(token); }
    }
  });

  it("allows native clients and authenticated packaged Electron origins, with exact HTTP allowlisting", () => {
    const policy = coreAccessPolicy("localhost", { token, allowedOrigins: ["http://localhost:5173"] });
    for (const origin of [undefined, "null", "file://", "http://localhost:5173"]) expect(policy.allowsOrigin(origin)).toBe(true);
    for (const origin of ["https://evil.test", "http://localhost:5173.evil.test", "http://localhost:5174"]) expect(policy.allowsOrigin(origin)).toBe(false);
    expect(coreAccessPolicy("localhost").allowsOrigin("null")).toBe(false);
    expect(coreAccessPolicy("localhost").allowsOrigin("file://")).toBe(false);
  });

  it("atomically creates one private token shared by concurrent starts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-auth-")); directories.push(directory);
    const file = path.join(directory, "tokens", "core.token");
    const values = await Promise.all(Array.from({ length: 8 }, () => loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN_FILE: file })));
    expect(new Set(values.map((value) => value.token)).size).toBe(1);
    expect(values[0]!.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(file, "utf8")).trim()).toBe(values[0]!.token);
    if (process.platform !== "win32") expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN_FILE: file })).token).toBe(values[0]!.token);
    const alias = path.join(directory, "alias.token"); await symlink(file, alias);
    await expect(loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN_FILE: alias })).rejects.toThrow("private regular file");
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN_FILE: file })).rejects.toThrow("private regular file");
    }
  });

  it("uses an explicitly configured token without creating files", async () => {
    expect(await loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN: token })).toEqual({ token });
    await expect(loadCoreSessionToken(7331, { REMOTE_IDE_SESSION_TOKEN: "unsafe" })).rejects.toThrow("32–256");
  });
});
