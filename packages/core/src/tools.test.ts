import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ToolInstallations, type Download, type ToolSpec } from "./tools.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary() { const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-tools-")); directories.push(directory); return directory; }
/** A tar.gz with one top-level directory holding `bin/tool`. */
async function archive(name: string) {
  const source = await temporary();
  await mkdir(path.join(source, "package/bin"), { recursive: true });
  await writeFile(path.join(source, "package/bin/tool"), name);
  const file = path.join(source, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", source, "package"]);
  return { file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
}
const spec = (id: string, version: string, sha256: string, requires?: string[]): ToolSpec => ({ id, name: id, description: id, version, stripRoot: true, requires, source: async () => ({ url: `https://example.test/${id}-${version}`, sha256, format: "tar.gz" }), entry: () => "bin/tool" });

it("installs prerequisites first, verifies checksums, reports progress and publishes complete installations", async () => {
  const root = await temporary();
  const runtime = await archive("runtime"); const server = await archive("server");
  const files: Record<string, string> = { "https://example.test/java-1": runtime.file, "https://example.test/jdtls-1": server.file };
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const download = vi.fn<Download>(async (url, file, progress) => { progress(5, 10); await gate; const data = await readFile(files[url]!); await writeFile(file, data); progress(10, 10); return createHash("sha256").update(data).digest("hex"); });
  const tools = new ToolInstallations(() => root, download, [spec("java", "1", runtime.sha256), spec("jdtls", "1", server.sha256, ["java"])]);
  const done = tools.install("jdtls");
  await vi.waitFor(async () => expect((await tools.list()).find((tool) => tool.id === "jdtls")).toMatchObject({ status: "installing", progress: 50 }));
  expect(() => tools.uninstall("jdtls")).toThrow("already running");
  release(); await done;
  expect(download.mock.calls.map(([url]) => url)).toEqual(["https://example.test/java-1", "https://example.test/jdtls-1"]);
  expect(await tools.list()).toMatchObject([{ id: "java", status: "installed", version: "1" }, { id: "jdtls", status: "installed", version: "1", requires: ["java"] }]);
  expect(await readFile(path.join((await tools.directory("jdtls"))!, "bin/tool"), "utf8")).toBe("server");
  expect(await readdir(path.join(root, "jdtls"))).not.toContain("download.tar.gz");
});

it("keeps a working installation when a download fails its checksum, then removes tools", async () => {
  const root = await temporary();
  const runtime = await archive("runtime");
  const good = vi.fn<Download>(async (_url, file) => { const data = await readFile(runtime.file); await writeFile(file, data); return runtime.sha256; });
  await new ToolInstallations(() => root, good, [spec("java", "1", runtime.sha256)]).install("java");
  const updated = new ToolInstallations(() => root, good, [spec("java", "2", "0".repeat(64))]);
  await expect(updated.install("java")).rejects.toThrow("checksum mismatch");
  expect(await updated.list()).toMatchObject([{ status: "installed", version: "1", availableVersion: "2", error: expect.stringContaining("checksum mismatch") }]);
  await updated.uninstall("java");
  expect(await updated.list()).toMatchObject([{ status: "not_installed" }]);
  expect((await readdir(path.join(root, "java"))).filter((name) => name.startsWith("installation-"))).toEqual([]);
});
