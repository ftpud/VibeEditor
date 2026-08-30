import assert from "node:assert/strict";
import test from "node:test";
import { connectionConfig, normalizeStoredAuthentication, testSshConnection } from "./connection-auth.js";

test("legacy stored connections default to password authentication", () => {
  assert.deepEqual(normalizeStoredAuthentication({ password: "encrypted" }), { password: "encrypted", authenticationMethod: "password" });
});
test("builds password and key SSH configs without mixing credentials", async () => {
  const password = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "password", password: "secret" }, async () => { throw new Error("not called"); });
  assert.equal(password.password, "secret"); assert.equal(password.privateKey, undefined);
  const key = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/keys/id", passphrase: "phrase" }, async () => Buffer.from("key"));
  assert.deepEqual(key.privateKey, Buffer.from("key")); assert.equal(key.passphrase, "phrase"); assert.equal(key.password, undefined);
});
test("omits an empty key passphrase and gives useful key-file failures", async () => {
  const config = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/keys/id", passphrase: "" }, async () => Buffer.from("key"));
  assert.equal(config.passphrase, undefined);
  await assert.rejects(connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/missing" }, async () => { throw new Error("ENOENT"); }), /Could not read the private key file/);
  await assert.rejects(connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "  " }, async () => Buffer.from("key")), /private key file is required/);
});
test("test connection propagates its config, closes a ready client, and returns failures", async () => {
  let ended = false; const config = { host: "host", port: 22, username: "user", password: "secret" };
  await testSshConnection(config, async (actual) => { assert.equal(actual, config); return { end: () => { ended = true; } }; });
  assert.equal(ended, true);
  await assert.rejects(testSshConnection(config, async () => { throw new Error("authentication failed"); }), /authentication failed/);
});
