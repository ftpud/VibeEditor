import assert from "node:assert/strict";
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

test("provisioning passes repository and branch as shell-quoted Git arguments", () => {
  const command = provisionCommand({ repository: "git@github.com:team/editor.git", branch: "release/v1", autoUpdate: true }, "export PATH=/bin");
  assert.match(command, /git clone --branch 'release\/v1' --single-branch 'git@github\.com:team\/editor\.git' ~\/\.vibe/);
  assert.match(command, /git -C ~\/\.vibe remote set-url origin 'git@github\.com:team\/editor\.git'/);
  assert.match(command, /git -C ~\/\.vibe fetch origin 'release\/v1'/);
});

test("disabled auto-update retains an existing checkout without fetching", () => {
  const command = provisionCommand({ repository: "https://example.com/editor.git", branch: "main", autoUpdate: false }, "export PATH=/bin");
  assert.doesNotMatch(command, /fetch origin/);
  assert.match(command, /git clone --branch 'main'/);
});

test("repair only removes dedicated Vibe dependencies and generated artifacts", () => {
  const command = provisionCommand(defaultRepositorySettings, "export PATH=/bin", true);
  assert.match(command, /rm -rf ~\/\.vibe\/node_modules ~\/\.vibe-build/);
  assert.doesNotMatch(command, /git reset/);
});
