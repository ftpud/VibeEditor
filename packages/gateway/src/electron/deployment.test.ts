import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { activateRelease, activatedReleaseVerificationCommand, WorkspaceOperations, coreHealthProbe, parseProvisionedRelease, serverActivationCommand, workspaceReleaseDirectory } from "./deployment.js";

const exec = promisify(execFile);
const oldRelease = `${"a".repeat(40)}-node137`;
const candidateRelease = `${"b".repeat(40)}-node137`;

test("parses a verified release and rejects malformed or mismatched identities", () => {
  assert.deepEqual(parseProvisionedRelease(`logs\nVIBE_RESULT:${"b".repeat(40)}:1:${candidateRelease}\n`), { commit: "b".repeat(40), rebuilt: true, release: candidateRelease });
  for (const release of ["../../arbitrary", oldRelease, `${candidateRelease};touch /tmp/bad`]) assert.throws(() => parseProvisionedRelease(`VIBE_RESULT:${"b".repeat(40)}:1:${release}\n`));
  assert.throws(() => serverActivationCommand("../bad", "/workspace", 7331, candidateRelease, "true"));
});

test("generated activation and workspace resolution commands are valid Bash", async () => {
  await exec("bash", ["-n", "-c", serverActivationCommand("test", "/workspace/it's a project", 7331, candidateRelease, "true")]);
  await exec("bash", ["-n", "-c", workspaceReleaseDirectory("test")]);
  await exec("bash", ["-n", "-c", activatedReleaseVerificationCommand("test", 7331, candidateRelease, "true")]);
});

test("health probe performs a real WebSocket protocol handshake", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-health-"));
  const sockets = new Set<net.Socket>();
  let handshake: unknown;
  const token = "gateway-probe-test-token-01234567890123456789";
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let upgraded = false;
    socket.on("data", (buffer) => {
      if (!upgraded) {
        const key = buffer.toString().match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)?.[1]?.trim();
        assert.ok(key);
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      } else if (buffer[0] === 0x81) {
        const length = buffer[1]! & 0x7f;
        const offset = length === 126 ? 4 : 2;
        const size = length === 126 ? buffer.readUInt16BE(2) : length;
        const mask = buffer.subarray(offset, offset + 4);
        const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
        handshake = JSON.parse(data.toString());
        const response = Buffer.from(JSON.stringify({ id: "gateway-health", ok: true, result: { compatible: true } }));
        socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
      }
    });
  });
  try {
    await mkdir(path.join(root, "packages/protocol/dist"), { recursive: true });
    await writeFile(path.join(root, "packages/protocol/dist/index.js"), "exports.protocolCompatibility={minimum:15,maximum:15};");
    // Resolve ws from the installed application, as the deployed probe does.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wsRoot = path.dirname(require.resolve("ws/package.json"));
    await mkdir(path.join(root, "node_modules/ws"), { recursive: true });
    await writeFile(path.join(root, "node_modules/ws/index.js"), `module.exports=require(${JSON.stringify(wsRoot)});`);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as net.AddressInfo;
    await exec(process.execPath, ["--input-type=commonjs", "-e", coreHealthProbe(address.port)], { cwd: root, timeout: 10_000, env: { ...process.env, REMOTE_IDE_SESSION_TOKEN: token } });
    assert.deepEqual(handshake, { id: "gateway-health", type: "protocol.handshake", payload: { compatibility: { minimum: 15, maximum: 15 }, token } });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const healthy of [true, false]) {
  test(`activation ${healthy ? "promotes a healthy candidate" : "restores the prior release after candidate failure"}`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "vibe-activation-"));
    const selection = path.join(home, ".vibe-server-test.release");
    const pidfile = path.join(home, ".vibe-server-test.pid");
    const bin = path.join(home, "bin");
    try {
      for (const release of [oldRelease, candidateRelease]) {
        const directory = path.join(home, ".vibe-deploy/releases", release, "packages/core/dist");
        await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "index.js"), "");
      }
      await mkdir(bin);
      await writeFile(path.join(bin, "node"), `#!/bin/bash\nif [ "$1" = 'packages/core/dist/index.js' ]; then exec -a "node packages/core/dist/index.js --gateway-workspace-id test --workspace /workspace/it's a project" sleep 60; fi\nif [ "$1" = '--input-type=commonjs' ]; then [ "$(basename "$PWD")" != "$FAIL_RELEASE" ]; exit $?; fi\nexit 99\n`, { mode: 0o755 });
      await writeFile(selection, oldRelease);
      await writeFile(path.join(home, ".vibe-server-test.token"), "c".repeat(healthy ? 256 : 32), { mode: 0o600 });
      let failed = false;
      try {
        await exec("bash", ["-c", serverActivationCommand("test", "/workspace/it's a project", 7331, candidateRelease, "true")], {
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAIL_RELEASE: healthy ? "none" : candidateRelease }, timeout: 15_000,
        });
      } catch (error) { failed = true; if (healthy) throw error; assert.match(String((error as { stderr: string }).stderr), /Previous Core release restored/); }
      assert.equal(failed, !healthy);
      assert.equal(await readFile(selection, "utf8"), healthy ? candidateRelease : oldRelease);
      assert.equal(await readFile(path.join(home, ".vibe-deploy/releases", oldRelease, "packages/core/dist/index.js"), "utf8"), "");
      if (healthy) assert.equal(await readFile(`${selection}.previous`, "utf8"), oldRelease);
      if (healthy) {
        const environment = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAIL_RELEASE: "none" };
        await exec("bash", ["-c", activatedReleaseVerificationCommand("test", 7331, candidateRelease, "true")], { env: environment });
        await assert.rejects(exec("bash", ["-c", activatedReleaseVerificationCommand("test", 7331, oldRelease, "true")], { env: environment }), /does not match/);
        await assert.rejects(exec("bash", ["-c", activatedReleaseVerificationCommand("test", 7331, candidateRelease, "true")], { env: { ...environment, FAIL_RELEASE: candidateRelease } }));
      }
      await assert.rejects(readFile(path.join(home, ".vibe-deploy/activate-test.lock/pid")), { code: "ENOENT" });
    } finally {
      try { process.kill(Number(await readFile(pidfile, "utf8")), "SIGKILL"); } catch { /* No surviving server. */ }
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("rejects malformed or out-of-range activation credentials before launching Core", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vibe-invalid-activation-token-"));
  try {
    for (const token of ["c".repeat(31), "c".repeat(257), `${"c".repeat(63)}!`]) {
      await writeFile(path.join(home, ".vibe-server-test.token"), token, { mode: 0o600 });
      await assert.rejects(exec("bash", ["-c", serverActivationCommand("test", "/workspace", 7331, candidateRelease, "true")], {
        env: { ...process.env, HOME: home }, timeout: 5_000,
      }), (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /Invalid Core session token file/);
        return true;
      });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("coalesces duplicate workspace actions and releases failed operations", async () => {
  const operations = new WorkspaceOperations();
  let finish!: (value: number) => void;
  let calls = 0;
  const first = operations.run("project", "start", () => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); });
  const duplicate = operations.run("project", "start", async () => 99);
  assert.equal(first, duplicate);
  await assert.rejects(operations.run("project", "stop", async () => {}), /busy with start/);
  await Promise.resolve(); assert.equal(calls, 1); finish(42);
  assert.equal(await first, 42);
  await assert.rejects(operations.run("project", "start", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await operations.run("project", "start", async () => 7), 7);
});

for (const reason of ["Remote command exited with 143", "SSH command interrupted: connection closed"]) {
  test(`verifies activation after its marker and ${reason}`, async () => {
    let activations = 0; let verifications = 0;
    await activateRelease(candidateRelease, async (output) => {
      activations++; output(`VIBE_ACTIVATED:${candidateRelease}`);
      throw new Error(reason);
    }, async () => { verifications++; });
    assert.equal(activations, 1); assert.equal(verifications, 1);
  });
}

test("does not verify or replay a failed activation without the matching release marker", async () => {
  let verifications = 0;
  await assert.rejects(activateRelease(candidateRelease, async (output) => {
    output(`VIBE_ACTIVATED:${oldRelease}`); throw new Error("Activation failed");
  }, async () => { verifications++; }), /Activation failed/);
  assert.equal(verifications, 0);
});

test("retains failure when an activation marker cannot be verified", async () => {
  await assert.rejects(activateRelease(candidateRelease, async (output) => {
    output(`VIBE_ACTIVATED:${candidateRelease}`); throw new Error("Remote command exited with 143");
  }, async () => { throw new Error("Core health check failed"); }), /could not be verified.*Core health check failed.*exited with 143/);
});

test("accepts a normal successful activation without reconnecting", async () => {
  let verifications = 0;
  await activateRelease(candidateRelease, async (output) => { output(`VIBE_ACTIVATED:${candidateRelease}`); }, async () => { verifications++; });
  assert.equal(verifications, 0);
});
