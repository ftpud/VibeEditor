import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultRepositorySettings, normalizeRepositorySettings, provisionCommand, repositorySettingsOrDefault } from "./repository-settings.js";

test("repository settings use the Vibe Editor source and main by default", () => {
  assert.deepEqual(normalizeRepositorySettings(undefined), defaultRepositorySettings);
  assert.equal(defaultRepositorySettings.branch, "main");
});

test("repository settings trim persisted values and reject unsafe input", () => {
  assert.deepEqual(normalizeRepositorySettings({ repository: " https://example.com/team/editor.git ", branch: " feature/gateway ", autoUpdate: false }), { repository: "https://example.com/team/editor.git", branch: "feature/gateway", autoUpdate: false });
  assert.throws(() => normalizeRepositorySettings({ repository: "https://example.com/a;rm -rf /", branch: "main" }));
  assert.throws(() => normalizeRepositorySettings({ repository: "https://example.com/editor.git", branch: "main;rm -rf /" }));
});

test("repository settings preserve saved auto-update choice", () => {
  const saved = JSON.parse(JSON.stringify(normalizeRepositorySettings({ repository: "https://example.com/editor.git", branch: "main", autoUpdate: false })));
  assert.deepEqual(normalizeRepositorySettings(saved), { repository: "https://example.com/editor.git", branch: "main", autoUpdate: false });
});

test("malformed persisted repository settings fall back without affecting other state", () => {
  const persisted = { connections: [{ id: "connection-1" }], workspaces: [{ id: "workspace-1" }], portTunnels: [{ id: "tunnel-1" }], repository: { repository: "https://example.com/a;rm -rf /", branch: "main" } };
  assert.deepEqual(repositorySettingsOrDefault(persisted.repository), defaultRepositorySettings);
  assert.equal(persisted.connections[0]?.id, "connection-1");
  assert.equal(persisted.workspaces[0]?.id, "workspace-1");
  assert.equal(persisted.portTunnels[0]?.id, "tunnel-1");
});

test("provisioning is valid shell and stages a commit-keyed immutable release", () => {
  const command = provisionCommand({ repository: "git@github.com:team/editor.git", branch: "release/v1", autoUpdate: true }, "export PATH=/bin");
  const syntax = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(command, /git -C "\$SOURCE_CACHE" fetch --no-tags origin "\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/);
  assert.match(command, /git -C "\$STAGING" checkout --detach "\$COMMIT"/);
  assert.match(command, /RELEASE_KEY="\$COMMIT-node\$NODE_ABI"/);
  assert.match(command, /npm ci/);
  assert.doesNotMatch(command, /npm install/);
  assert.match(command, /while ! mkdir "\$LOCK"/);
  assert.match(command, /owner_is_alive/);
  assert.match(command, /Timed out waiting for provisioning lock with unknown owner/);
  assert.match(command, /VIBE_RESULT:%s:%s:%s/);
  assert.doesNotMatch(command, /rm -rf ~\/\.vibe(?: |\/)/);
});

test("disabled auto-update uses the source cache without fetching except on first provision", () => {
  const command = provisionCommand({ repository: "https://example.com/editor.git", branch: "main", autoUpdate: false }, "export PATH=/bin");
  assert.match(command, /AUTO_UPDATE=0/);
  assert.match(command, /\[ "\$AUTO_UPDATE" = 1 \] \|\| \[ ! -f "\$SOURCE_CACHE\/selected" \]/);
  assert.match(command, /git -C "\$SOURCE_CACHE" fetch --no-tags origin "\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/);
  assert.match(command, /COMMIT=\$\(cat "\$SOURCE_CACHE\/selected"\)/);
});

test("repair stages a unique release and keeps existing releases untouched", () => {
  const command = provisionCommand(defaultRepositorySettings, "export PATH=/bin", true);
  assert.match(command, /RELEASE_KEY="\$COMMIT-node\$NODE_ABI-repair-\$REPAIR_NONCE"/);
  assert.match(command, /  rebuilt=1/);
  assert.match(command, /mktemp -d "\$RELEASES\/\.staging-\$RELEASE_KEY/);
  assert.match(command, /refusing to replace an immutable release/);
  assert.match(command, /release_is_valid "\$RELEASE_PATH"[\s\S]*?if \[ "\$SELECTED_UPDATE" = 1 \]; then/);
  assert.doesNotMatch(command, /rm -rf ~\/\.vibe(?: |\/)/);
});

test("failed repair leaves prior releases intact and successful repairs get unique keys", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vibe-provision-test-"));
  const repository = path.join(temporary, "source");
  const home = path.join(temporary, "remote-home");
  const fakeBin = path.join(temporary, "bin");
  const npmLog = path.join(temporary, "npm.log");
  const fakeRemote = "https://fixture.invalid/team/editor.git";
  await mkdir(repository, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(path.join(repository, "package-lock.json"), JSON.stringify({ name: "provision-fixture", lockfileVersion: 3, requires: true, packages: {} }));
  await writeFile(path.join(repository, "source.txt"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "branch", "-M", "main"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
  const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const fakeNpm = path.join(fakeBin, "npm");
  await writeFile(fakeNpm, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FAKE_NPM_LOG\"",
    "if [ \"$1\" = ci ]; then",
    "  if [ \"${FAKE_NPM_FAIL:-0}\" = 1 ]; then echo 'simulated npm ci failure' >&2; exit 23; fi",
    "  mkdir -p node_modules/node-pty packages/core/dist packages/desktop/dist-electron packages/desktop/dist-renderer packages/protocol/dist",
    "  printf '%s\\n' '{\"type\":\"commonjs\"}' > node_modules/node-pty/package.json",
    "  printf '%s\\n' 'module.exports = {};' > node_modules/node-pty/index.js",
    "  printf '%s\\n' 'export const protocolCompatibility = { minimum: 1, maximum: 1 };' > packages/protocol/dist/index.js",
    "  printf '%s\\n' 'export const ready = true;' > packages/core/dist/server.js",
    "  printf '%s\\n' 'export const ready = true;' > packages/core/dist/index.js",
    "  printf '%s\\n' 'export const ready = true;' > packages/desktop/dist-electron/main.js",
    "  printf '%s\\n' '<html></html>' > packages/desktop/dist-renderer/index.html",
    "fi",
  ].join("\n"), { mode: 0o755 });
  const fakeGit = path.join(fakeBin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(fakeGit, [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2).map((argument) => argument === process.env.FAKE_REMOTE_URL ? process.env.FAKE_GIT_REPO : argument);",
    "const result = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });",
    "if (result.error) { console.error(result.error); process.exit(1); }",
    "process.exit(result.status ?? 1);",
  ].join("\n"), { mode: 0o755 });

  const remoteEnvironment = `export PATH=${testShell(fakeBin)}:"$PATH"; export FAKE_NPM_LOG=${testShell(npmLog)}; export REAL_GIT=${testShell(realGit)}; export FAKE_REMOTE_URL=${testShell(fakeRemote)}; export FAKE_GIT_REPO=${testShell(repository)}`;
  const settings = { repository: fakeRemote, branch: "main", autoUpdate: false };
  const runProvision = (autoUpdate: boolean, repair = false, fail = false, preferredRelease?: string) => spawnSync("bash", ["-c", provisionCommand({ ...settings, autoUpdate }, remoteEnvironment, repair, preferredRelease)], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...(fail ? { FAKE_NPM_FAIL: "1" } : {}) },
  });

  const first = runProvision(false);
  assert.equal(first.status, 0, first.stderr);
  const initialResult = first.stdout.match(new RegExp(`VIBE_RESULT:${commit}:1:([a-f0-9]+-node[0-9]+)`));
  assert.ok(initialResult, first.stdout);
  const initialRelease = path.join(home, ".vibe-deploy", "releases", initialResult[1]!);
  await writeFile(path.join(initialRelease, "preserve-me"), "known-good\n");
  const npmLogBeforeReuse = await readFile(npmLog, "utf8");
  const reuse = runProvision(false);
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.match(reuse.stdout, new RegExp(`VIBE_RESULT:${commit}:0:${initialResult[1]}`));
  assert.equal(await readFile(npmLog, "utf8"), npmLogBeforeReuse);

  const repairOne = runProvision(false, true);
  assert.equal(repairOne.status, 0, repairOne.stderr);
  const repairOneKey = repairOne.stdout.match(new RegExp(`VIBE_RESULT:${commit}:1:([a-f0-9]+-node[0-9]+-repair-[a-zA-Z0-9]+)`))?.[1];
  assert.ok(repairOneKey, repairOne.stdout);
  const repairTwo = runProvision(false, true);
  assert.equal(repairTwo.status, 0, repairTwo.stderr);
  const repairTwoKey = repairTwo.stdout.match(new RegExp(`VIBE_RESULT:${commit}:1:([a-f0-9]+-node[0-9]+-repair-[a-zA-Z0-9]+)`))?.[1];
  assert.ok(repairTwoKey, repairTwo.stdout);
  assert.notEqual(repairOneKey, repairTwoKey);

  const sourceCache = path.join(home, ".vibe-deploy", "sources", (await readdir(path.join(home, ".vibe-deploy", "sources")))[0]!);
  const selectedPath = path.join(sourceCache, "selected");
  const selectedBeforeUpdate = await readFile(selectedPath, "utf8");
  const preferred = repairTwo.stdout.match(/VIBE_RESULT:[a-f0-9]+:1:([^\n]+)/)?.[1];
  assert.ok(preferred);
  const reuseRepair = runProvision(false, false, false, preferred);
  assert.equal(reuseRepair.status, 0, reuseRepair.stderr);
  assert.match(reuseRepair.stdout, new RegExp(`VIBE_RESULT:${commit}:0:${preferred}`));

  const beforeFailure = await readdir(path.join(home, ".vibe-deploy", "releases"));
  await writeFile(path.join(repository, "source.txt"), "updated fixture\n");
  execFileSync("git", ["-C", repository, "add", "source.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "updated fixture"]);
  const updatedCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.notEqual(updatedCommit, commit);
  const failedUpdate = runProvision(true, false, true);
  assert.notEqual(failedUpdate.status, 0);
  assert.match(failedUpdate.stderr, /simulated npm ci failure/);
  assert.equal(await readFile(selectedPath, "utf8"), selectedBeforeUpdate);
  assert.deepEqual(await readdir(path.join(home, ".vibe-deploy", "releases")), beforeFailure);
  const offlineReuse = runProvision(false);
  assert.equal(offlineReuse.status, 0, offlineReuse.stderr);
  assert.match(offlineReuse.stdout, new RegExp(`VIBE_RESULT:${commit}:0:${initialResult[1]}`));
  assert.equal(await readFile(selectedPath, "utf8"), selectedBeforeUpdate);

  const failedRepair = runProvision(false, true, true);
  assert.notEqual(failedRepair.status, 0);
  assert.match(failedRepair.stderr, /simulated npm ci failure/);
  assert.deepEqual(await readdir(path.join(home, ".vibe-deploy", "releases")), beforeFailure);
  assert.equal(await readFile(path.join(initialRelease, "preserve-me"), "utf8"), "known-good\n");
  assert.equal((await readdir(path.join(home, ".vibe-deploy", "releases"))).some((name) => name.startsWith(".staging-")), false);
  assert.match(await readFile(npmLog, "utf8"), /run build -w @remote-ide\/acp/);
  assert.match(await readFile(npmLog, "utf8"), /run build -w @remote-ide\/protocol/);
  assert.match(await readFile(npmLog, "utf8"), /run build -w @remote-ide\/core/);
  assert.match(await readFile(npmLog, "utf8"), /run build -w @remote-ide\/desktop/);
  await rm(temporary, { recursive: true, force: true });
});

function testShell(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
