import assert from "node:assert/strict";
import test from "node:test";
import { connectionConfig, formatHostFingerprint, hostKeyVerifier, normalizeStoredAuthentication, sshConnectionError, testSshConnection } from "./connection-auth.js";

// Deliberately generated test-only keys. They are not used by any host.
const rsaPrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEA3MUdkDC3W4999pld0E5GdgVOa3Ksri6bNPCiC3IctNj2RddA8aqC
+jqTNIvxwrKfKvl5IOUS6rIOQ2dVxcBMJiuAo0MunG2c2Pw0ubxWZr7XHJlaiP/qXPhQAe
FQO64aTMv2lVxIiAPcxU3Q8NToeleyRF64rkMLVsqxkNakq9AOzfWHkMne1TMr0aSjulez
xjPMBX6gIotHUOK8PbGFb2zJIL+ct9LRvt67tOTkRsMFTEER2Lz4ZMbupK2YkyDbc9NkNt
AwRUW+KKl7rVtIi4I37W1M/nYV4lE6I63YYPtWzl010UhfutpRMGF7cLf/g3RJX0zFhpzJ
PNREbOcEewAAA8D5CsvI+QrLyAAAAAdzc2gtcnNhAAABAQDcxR2QMLdbj332mV3QTkZ2BU
5rcqyuLps08KILchy02PZF10DxqoL6OpM0i/HCsp8q+Xkg5RLqsg5DZ1XFwEwmK4CjQy6c
bZzY/DS5vFZmvtccmVqI/+pc+FAB4VA7rhpMy/aVXEiIA9zFTdDw1Oh6V7JEXriuQwtWyr
GQ1qSr0A7N9YeQyd7VMyvRpKO6V7PGM8wFfqAii0dQ4rw9sYVvbMkgv5y30tG+3ru05ORG
wwVMQRHYvPhkxu6krZiTINtz02Q20DBFRb4oqXutW0iLgjftbUz+dhXiUTojrdhg+1bOXT
XRSF+62lEwYXtwt/+DdElfTMWGnMk81ERs5wR7AAAAAwEAAQAAAQAZYDrmsQLSbmrvJm/H
Gsg0lqWN6i95EfhbHHGz2Rj9nJaqLnTTkmLduk/jUVanp3puKSDILCyBd5f2HXGZemIGXS
e7HGTGLD9EHbE9zC0uQC9fpSzn5Gqe5xfjL2/WfEufmi4sut/HapI8x5YFqKNUNLJT84NM
3H34KvJAELv614euB6mlo6IaeQQdcY/VETa7AG+LvKBF/AWCPUQrTr5PjHl6KXX1DDOsdp
877vaFQ193kt2DhcRX2HZ/fJS8mwXOJ2DBswTqbr1yNzfKKh6mloTIhoKmYI+ylOkJj6JA
Dryml7NAeucakDPelwnPQ46hov2NO79WkPZm2f1B/RQZAAAAgQC/TePJkQirFtcOrDzDhc
dETUqH5qi3coGVDi8G8dI4jeCjGUuABsmHLd5GXeCsm1bfue3zKCLNFSuDUssoZMaEGpWT
3EHfSq8tABbPrq4M4tasbRt0vUMPI43+Q/w9KktC46fSBMxyXZHTXD/S4jahPLvPTol197
D8djK2XJbr+QAAAIEA4HWLilWEfZelAIo6vaMJ1Ir0sWQ+weVmrYUWwmfyZzmhCb3p6x+t
1gnv/LQMDCDgHA/FKi7XAmO5VLOvXcM7X1dBs8Mtu6ulvbMTDZk4sFTgb0aUl/SGzoY32m
H78q7j9JdyC+yIuKIevb9O5yCaE32RI/AUovNUuc3aWRewX8UAAACBAPvK3B4mzaExwke9
5GaqFCPwefq2leF7BHgkrA0eRV30LjKjM8HA2gZAzMXH/EYlWKPgi+iIuHYReVF9V/B7sV
b2F9xBEwXdkgEsq3c9xLQfwU7i4stet5OmBvfACncoJsnJNPtUYVPsIrO7vPXnd+Fyi96S
E5VCj0qbCjpP3dc/AAAACWZ0cHVkQGZ0cAE=
-----END OPENSSH PRIVATE KEY-----`;
const ed25519PrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACC3g5BBOUUjzV8kTO+AgsRbs7qDaG6F03VbwbDlKxOeVwAAAJCqQPQNqkD0
DQAAAAtzc2gtZWQyNTUxOQAAACC3g5BBOUUjzV8kTO+AgsRbs7qDaG6F03VbwbDlKxOeVw
AAAEAToUpJwL/EbF31YYq2yxegiInBFvVZw2rj4uoqZsHpC7eDkEE5RSPNXyRM74CCxFuz
uoNoboXTdVvBsOUrE55XAAAACWZ0cHVkQGZ0cAECAwQ=
-----END OPENSSH PRIVATE KEY-----`;
const encryptedEd25519PrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABB/CW0xgr
I7ULltphKUF78vAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAICJGbnSRkRT2YQpb
LL6zW1G3uolQpZ0muETdxwKtaQmLAAAAkERycPTuSZHyZTsuEOFSnbuBNFVviut9Ywb/jW
SGPhLeBNRpIhvHmYLBJlYyoBsyHIEXzI2BRcg+u1y4tiIuC8NBb7qTC8xWM6XB4fMr3u6r
akkyC+IO1v4u/3t3WteP9w1oJP2JXR6t/V7+Bysnflgor+mOLy0+/I7B5RCI0TdoqfpuBn
NBD0KCm6eosAFNNA==
-----END OPENSSH PRIVATE KEY-----`;
const publicKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDcxR2QMLdbj332mV3QTkZ2BU5rcqyuLps08KILchy02PZF10DxqoL6OpM0i/HCsp8q+Xkg5RLqsg5DZ1XFwEwmK4CjQy6cbZzY/DS5vFZmvtccmVqI/+pc+FAB4VA7rhpMy/aVXEiIA9zFTdDw1Oh6V7JEXriuQwtWyrGQ1qSr0A7N9YeQyd7VMyvRpKO6V7PGM8wFfqAii0dQ4rw9sYVvbMkgv5y30tG+3ru05ORGwwVMQRHYvPhkxu6krZiTINtz02Q20DBFRb4oqXutW0iLgjftbUz+dhXiUTojrdhg+1bOXTXRSF+62lEwYXtwt/+DdElfTMWGnMk81ERs5wR7";

test("legacy stored connections default to password authentication", () => {
  assert.deepEqual(normalizeStoredAuthentication({ password: "encrypted" }), { password: "encrypted", authenticationMethod: "password" });
});
test("builds password and key SSH configs without mixing credentials", async () => {
  const password = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "password", password: "secret" }, async () => { throw new Error("not called"); });
  assert.equal(password.password, "secret"); assert.equal(password.privateKey, undefined);
  const key = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/keys/id", passphrase: "fixture passphrase" }, async () => Buffer.from(encryptedEd25519PrivateKey));
  assert.deepEqual(key.privateKey, Buffer.from(encryptedEd25519PrivateKey)); assert.equal(key.passphrase, "fixture passphrase"); assert.equal(key.password, undefined);
});
test("uses an OS SSH agent without persisting or reading private-key material", async () => {
  const previous = process.env.SSH_AUTH_SOCK; process.env.SSH_AUTH_SOCK = "/tmp/test-agent.sock";
  try {
    const config = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "agent" }, async () => { throw new Error("private key must not be read"); });
    assert.equal(config.agent, "/tmp/test-agent.sock"); assert.equal(config.privateKey, undefined); assert.equal(config.password, undefined);
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previous;
  }
});
test("requires a supported OS SSH agent for agent authentication", async () => {
  const previous = process.env.SSH_AUTH_SOCK; delete process.env.SSH_AUTH_SOCK;
  try { await assert.rejects(connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "agent" }, async () => Buffer.alloc(0)), /SSH_AUTH_SOCK/); }
  finally { if (previous !== undefined) process.env.SSH_AUTH_SOCK = previous; }
});
test("formats and pins SHA-256 host fingerprints", () => {
  let observed = "";
  const verifier = hostKeyVerifier("SHA256:known", (value) => { observed = value; });
  assert.equal(verifier("known"), true); assert.equal(observed, "SHA256:known");
  assert.equal(verifier("changed"), false); assert.equal(observed, "SHA256:changed");
  assert.equal(formatHostFingerprint("SHA256:value"), "SHA256:value");
});
test("omits an empty key passphrase and gives useful key-file failures", async () => {
  const config = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/keys/id", passphrase: "" }, async () => Buffer.from(rsaPrivateKey));
  assert.equal(config.passphrase, undefined);
  await assert.rejects(connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/missing" }, async () => { throw new Error("ENOENT"); }), /Could not read the private key file/);
  await assert.rejects(connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "  " }, async () => Buffer.from("key")), /private key file is required/);
});
test("accepts representative RSA and Ed25519 private keys, including encrypted OpenSSH keys", async () => {
  for (const [key, passphrase] of [[rsaPrivateKey, undefined], [ed25519PrivateKey, undefined], [encryptedEd25519PrivateKey, "fixture passphrase"]] as const) {
    const config = await connectionConfig({ host: "host", port: 22, username: "user", authenticationMethod: "privateKey", privateKeyPath: "/keys/id", ...(passphrase ? { passphrase } : {}) }, async () => Buffer.from(key));
    assert.ok(Buffer.isBuffer(config.privateKey));
  }
});
test("rejects public, malformed, missing-passphrase, and wrong-passphrase key input before connecting", async () => {
  const config = { host: "host", port: 22, username: "user", authenticationMethod: "privateKey" as const, privateKeyPath: "/keys/id" };
  await assert.rejects(connectionConfig(config, async () => Buffer.from(publicKey)), /public key/);
  await assert.rejects(connectionConfig({ ...config, privateKeyPath: "/keys/id_rsa.pub" }, async () => Buffer.from(rsaPrivateKey)), /public-key \(.pub\) file/);
  await assert.rejects(connectionConfig(config, async () => Buffer.from("not a key")), /not a supported SSH private key/);
  await assert.rejects(connectionConfig(config, async () => Buffer.from(encryptedEd25519PrivateKey)), /requires its passphrase/);
  await assert.rejects(connectionConfig({ ...config, passphrase: "wrong" }, async () => Buffer.from(encryptedEd25519PrivateKey)), /passphrase is incorrect/);
});
test("translates rejected private-key authentication without exposing key material", () => {
  assert.match(sshConnectionError(new Error("All configured authentication methods failed"), "privateKey").message, /authorized_keys/);
  assert.equal(sshConnectionError(new Error("Connection timed out"), "privateKey").message, "Connection timed out");
  assert.match(sshConnectionError(new Error("Host denied (verification failed)"), "password").message, /does not match/);
});
test("test connection propagates its config, closes a ready client, and returns failures", async () => {
  let ended = false; const config = { host: "host", port: 22, username: "user", password: "secret" };
  await testSshConnection(config, async (actual) => { assert.equal(actual, config); return { end: () => { ended = true; } }; });
  assert.equal(ended, true);
  await assert.rejects(testSshConnection(config, async () => { throw new Error("authentication failed"); }), /authentication failed/);
});
