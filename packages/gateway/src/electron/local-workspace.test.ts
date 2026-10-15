import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareLocalWorkspaceDirectory } from "./local-workspace.js";

test("creates missing local workspace parents and preserves existing project files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-local-workspace-"));
  try {
    const directory = path.join(temporary, "new parent", "developer's project");
    const prepared = await prepareLocalWorkspaceDirectory(directory);
    assert.equal(prepared, await realpath(directory));
    assert.ok((await stat(prepared)).isDirectory());
    assert.match(await readFile(path.join(prepared, ".git", "HEAD"), "utf8"), /^ref: refs\/heads\//);
    await writeFile(path.join(prepared, "keep.txt"), "existing content");
    assert.equal(await prepareLocalWorkspaceDirectory(directory), prepared);
    assert.equal(await readFile(path.join(prepared, "keep.txt"), "utf8"), "existing content");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("rejects files, invalid paths and file ancestors without modifying contents", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-local-workspace-"));
  try {
    const file = path.join(temporary, "keep.txt");
    await writeFile(file, "keep");
    await assert.rejects(prepareLocalWorkspaceDirectory(file), /not a directory/);
    await assert.rejects(prepareLocalWorkspaceDirectory(path.join(file, "child")), /not a directory/);
    await assert.rejects(prepareLocalWorkspaceDirectory("relative/project"), /absolute path/);
    await assert.rejects(prepareLocalWorkspaceDirectory(`${temporary}/bad\npath`), /control characters/);
    assert.equal(await readFile(file, "utf8"), "keep");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test("preserves nonempty folders and inherits the parent repository for empty children", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-local-git-"));
  try {
    const existing = path.join(temporary, "existing");
    await mkdir(existing);
    await writeFile(path.join(existing, "keep.txt"), "keep");
    await prepareLocalWorkspaceDirectory(existing);
    await assert.rejects(access(path.join(existing, ".git")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(existing, "keep.txt"), "utf8"), "keep");
    const repository = path.join(temporary, "repository");
    await promisify(execFile)("git", ["init", "--quiet", repository]);
    const child = path.join(repository, "new child");
    await prepareLocalWorkspaceDirectory(child);
    await assert.rejects(access(path.join(child, ".git")), { code: "ENOENT" });
    const result = await promisify(execFile)("git", ["-C", child, "rev-parse", "--show-toplevel"]);
    assert.equal(result.stdout.trim(), await realpath(repository));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
