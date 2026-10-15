import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionToken } from "./connection-token.js";

const tokenEnvironment = ["REMOTE_IDE_SESSION_TOKEN", "REMOTE_IDE_SESSION_TOKEN_FILE"] as const;
let previousEnvironment: Record<(typeof tokenEnvironment)[number], string | undefined>;
let temporaryDirectory: string;

beforeEach(async () => {
  previousEnvironment = {
    REMOTE_IDE_SESSION_TOKEN: process.env.REMOTE_IDE_SESSION_TOKEN,
    REMOTE_IDE_SESSION_TOKEN_FILE: process.env.REMOTE_IDE_SESSION_TOKEN_FILE,
  };
  delete process.env.REMOTE_IDE_SESSION_TOKEN;
  delete process.env.REMOTE_IDE_SESSION_TOKEN_FILE;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "connection-token-test-"));
});

afterEach(async () => {
  for (const key of tokenEnvironment) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("connectionToken launch binding", () => {
  it("returns an explicit token when the selected target matches the launch target", async () => {
    process.env.REMOTE_IDE_SESSION_TOKEN = "launch-secret";

    await expect(connectionToken("core.example", 4312, { host: "CORE.EXAMPLE", port: "4312" })).resolves.toBe("launch-secret");
  });

  it("rejects credentials for a different host or port without returning them", async () => {
    process.env.REMOTE_IDE_SESSION_TOKEN = "launch-secret";

    await expect(connectionToken("attacker.example", 4312, { host: "core.example", port: "4312" })).rejects.toThrow("does not match the launch target");
    await expect(connectionToken("core.example", 4313, { host: "core.example", port: "4312" })).rejects.toThrow("does not match the launch target");
    await expect(connectionToken("127.0.0.2", 4312, { host: "127.0.0.1", port: "4312" })).rejects.toThrow("does not match the launch target");
  });

  it("binds an explicitly configured token file to the launch target", async () => {
    const tokenFile = path.join(temporaryDirectory, "session.token");
    await writeFile(tokenFile, "file-secret\n", "utf8");
    process.env.REMOTE_IDE_SESSION_TOKEN_FILE = tokenFile;

    await expect(connectionToken("core.example", 4312, { host: "core.example", port: "4312" })).resolves.toBe("file-secret");
    await expect(connectionToken("other.example", 4312, { host: "core.example", port: "4312" })).rejects.toThrow("does not match the launch target");
  });

  it("rejects malformed launch targets", async () => {
    process.env.REMOTE_IDE_SESSION_TOKEN = "launch-secret";

    await expect(connectionToken("core.example", 4312, { host: "core.example", port: "65536" })).rejects.toThrow("Invalid Core launch target");
    await expect(connectionToken("core.example", 4312, { host: "core.example", port: "not-a-port" })).rejects.toThrow("Invalid Core launch target");
  });

  it("keeps direct-launch credentials working when no complete launch target is supplied", async () => {
    process.env.REMOTE_IDE_SESSION_TOKEN = "direct-launch-secret";

    await expect(connectionToken("direct.example", 4312)).resolves.toBe("direct-launch-secret");
    await expect(connectionToken("direct.example", 4312, { host: "direct.example" })).resolves.toBe("direct-launch-secret");
    await expect(connectionToken("other.example", 4312, { host: "direct.example" })).resolves.toBe("direct-launch-secret");
  });

  it("returns undefined for a remote target without an explicit credential", async () => {
    await expect(connectionToken("core.example", 4312)).resolves.toBeUndefined();
  });

  it("rejects an invalid selected connection target", async () => {
    await expect(connectionToken("core.example", 0)).rejects.toThrow("Invalid Core connection target");
  });
});
