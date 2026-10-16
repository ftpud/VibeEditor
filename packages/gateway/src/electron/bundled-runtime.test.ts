import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { coreTarget, installBundleCommand, loadBundle, verifiedCoreArchive, type CoreBundle } from "./bundled-runtime.js";
import { parseProvisionedRelease, workspaceReleaseDirectory } from "./deployment.js";

const execute = promisify(execFile);
const commit = "a".repeat(40);
const release = `${commit}-node137-bundle-123-1-linux-x64`;
test("selects portable Core for Linux, WSL and Apple Silicon and rejects unsupported hosts", () => {
  assert.equal(coreTarget("Linux", "x86_64"), "linux-x64");
  assert.equal(coreTarget("Linux", "aarch64"), "linux-arm64");
  assert.equal(coreTarget("Darwin", "arm64"), "darwin-arm64");
  assert.throws(() => coreTarget("Darwin", "x86_64"));
  assert.throws(() => coreTarget("Windows_NT", "AMD64"));
});
test("validates the complete packaged manifest and archive contents", async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), "vibe-bundle-manifest-"));
  try {
    await mkdir(path.join(resources, "bundle/cores"), { recursive: true });
    const content = "fixture archive";
    const cores = Object.fromEntries(["linux-x64", "linux-arm64", "darwin-arm64"].map(target => [target, { target, commit, release, archive: `core-${target}.tar.gz`, sha256: createHash("sha256").update(content).digest("hex") }]));
    const manifest = { schema: 1, channel: "early-access", commit, version: "0.1.0", desktopExecutable: "desktop/Vibe Editor.exe", cores };
    const file = path.join(resources, "bundle/manifest.json");
    await writeFile(file, JSON.stringify(manifest));
    assert.equal((await loadBundle(resources)).commit, commit);
    const core = cores["linux-x64"]!;
    await writeFile(path.join(resources, "bundle/cores", core.archive), content);
    await verifiedCoreArchive(resources, core);
    await writeFile(path.join(resources, "bundle/cores", core.archive), "corrupt");
    await assert.rejects(verifiedCoreArchive(resources, core), /checksum failed/);
    delete cores["linux-arm64"];
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(loadBundle(resources), /Invalid bundled Core/);
  } finally { await rm(resources, { recursive: true, force: true }); }
});
test("installs a verified archive without host Node, npm, or Git, reuses it and rejects checksum changes", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vibe-bundle-deploy-"));
  try {
    const fixture = path.join(home, "fixture");
    await mkdir(path.join(fixture, "bin"), { recursive: true });
    await mkdir(path.join(fixture, "node_modules/node-pty"), { recursive: true });
    await mkdir(path.join(fixture, "packages/core/dist"), { recursive: true });
    await cp(process.execPath, path.join(fixture, "bin/node"));
    await writeFile(path.join(fixture, "node_modules/node-pty/index.js"), "module.exports={};");
    await writeFile(path.join(fixture, "packages/core/dist/server.js"), "exports.loaded=true;");
    const upload = ".vibe-upload-fixture";
    const archive = path.join(home, "fixture.tar.gz");
    await execute("tar", ["-czf", archive, "-C", fixture, "."]);
    const core: CoreBundle = { target: "linux-x64", commit, release, archive: "core-linux-x64.tar.gz", sha256: createHash("sha256").update(await readFile(archive)).digest("hex") };
    const install = async (metadata = core) => {
      await mkdir(path.join(home, upload), { recursive: true });
      await cp(archive, path.join(home, upload, "core.tar.gz"));
      return execute("bash", ["-c", installBundleCommand(metadata, upload)], { env: { ...process.env, HOME: home } });
    };
    const first = await install();
    assert.equal(parseProvisionedRelease(first.stdout).release, release);
    const destination = path.join(home, ".vibe-deploy/releases", release);
    await writeFile(path.join(destination, "sentinel"), "preserved");
    await install();
    assert.equal(await readFile(path.join(destination, "sentinel"), "utf8"), "preserved");
    await assert.rejects(install({ ...core, sha256: "0".repeat(64) }), /checksum failed/);
    await writeFile(path.join(home, ".vibe-server-test.release"), release);
    const resolved = await execute("bash", ["-c", `${workspaceReleaseDirectory("test")}; printf '%s' "$release_directory"`], { env: { ...process.env, HOME: home } });
    assert.equal(resolved.stdout, destination);
    assert.equal(await readFile(path.join(destination, "sentinel"), "utf8"), "preserved");
  } finally { await rm(home, { recursive: true, force: true }); }
});
