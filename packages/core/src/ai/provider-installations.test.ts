import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderInstallations, type InstallationSpec, type Npm } from "./provider-installations.js";

const spec: InstallationSpec = { package: "@agentclientprotocol/codex-acp", bin: "dist/index.js" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(versions: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-provider-installations-")); directories.push(root);
  const published = [...versions];
  const npm = {
    latest: vi.fn(async (_name: string, _tag?: string) => { const version = published[0]; if (!version) throw new Error("offline"); return version; }),
    install: vi.fn(async (directory: string, specifier: string) => {
      const version = specifier.slice(specifier.lastIndexOf("@") + 1);
      const target = path.join(directory, "node_modules", spec.package);
      await mkdir(path.join(target, "dist"), { recursive: true });
      await writeFile(path.join(target, "dist/index.js"), "");
      await writeFile(path.join(target, "package.json"), JSON.stringify({ version }));
    })
  } satisfies Npm;
  return { root, npm, published, installations: new ProviderInstallations(() => root, npm) };
}

it("installs once for concurrent requests and reports the installed version", async () => {
  const { installations, npm } = await fixture(["1.0.0"]);
  expect(await installations.state("codex", spec)).toMatchObject({ status: "not_installed" });
  const first = installations.install("codex", spec);
  expect((await installations.state("codex", spec)).status).toBe("installing");
  await Promise.all([first, installations.install("codex", spec)]);
  expect(npm.install).toHaveBeenCalledTimes(1);
  expect(npm.install.mock.calls[0]?.[1]).toBe("@agentclientprotocol/codex-acp@1.0.0");
  expect(await installations.state("codex", spec)).toMatchObject({ status: "installed", source: "managed", version: "1.0.0", latestVersion: "1.0.0" });
  expect(await installations.entry("codex", spec)).toMatch(/dist[\\/]index\.js$/);
});

it("updates to the latest version, skips unchanged versions and keeps the working installation when an update fails", async () => {
  const { installations, npm, published, root } = await fixture(["1.0.0"]);
  await installations.install("codex", spec);
  await installations.install("codex", spec);
  expect(npm.install).toHaveBeenCalledTimes(1);
  published[0] = "1.1.0";
  expect((await installations.state("codex", spec, true)).latestVersion).toBe("1.0.0"); // cached
  await installations.install("codex", spec);
  expect((await installations.state("codex", spec)).version).toBe("1.1.0");
  const before = await readFile(path.join(root, "codex", "current.json"), "utf8");
  published[0] = "1.2.0";
  npm.install.mockRejectedValueOnce(new Error("network down"));
  await expect(installations.install("codex", spec)).rejects.toThrow("network down");
  expect(await readFile(path.join(root, "codex", "current.json"), "utf8")).toBe(before);
  expect(await installations.state("codex", spec)).toMatchObject({ status: "installed", version: "1.1.0", error: expect.stringContaining("network down") });
  expect((await readdir(path.join(root, "codex"))).filter(name => name.startsWith("installation-"))).toHaveLength(2);
});

it("removes managed installations and refuses to manage Core-host overrides", async () => {
  const { installations } = await fixture(["1.0.0"]);
  await installations.install("codex", spec);
  const removal = installations.uninstall("codex", spec);
  expect(() => installations.install("codex", spec)).toThrow("already running");
  await removal;
  expect(await installations.state("codex", spec)).toMatchObject({ status: "not_installed" });
  expect(await installations.entry("codex", spec)).toBeUndefined();
  const external = { ...spec, override: () => "/usr/local/bin/codex-acp" };
  expect(await installations.state("codex", external)).toMatchObject({ status: "installed", source: "external", location: "/usr/local/bin/codex-acp" });
  expect(() => installations.uninstall("codex", external)).toThrow("Core-host override");
});

it("stores the ACP protocol per provider and installs v2 from its release channel", async () => {
  const { installations, npm } = await fixture(["1.0.0"]);
  npm.latest.mockImplementation(async (_name: string, tag = "latest") => tag === "preview" ? "2.0.0-preview.3" : "1.0.0");
  const v2 = { ...spec, protocols: { v2: { distTag: "preview" } } };
  expect(await installations.state("codex", v2)).toMatchObject({ protocol: "v1", protocols: ["v1", "v2"] });
  expect(await installations.state("codex", spec)).not.toHaveProperty("protocols");
  await installations.install("codex", v2);
  expect(npm.install.mock.calls.at(-1)?.[1]).toBe("@agentclientprotocol/codex-acp@1.0.0");
  await installations.setProtocol("codex", "v2");
  expect(await installations.state("codex", v2, true)).toMatchObject({ protocol: "v2", channel: "preview", version: "1.0.0", latestVersion: "2.0.0-preview.3" });
  await installations.install("codex", v2);
  expect(npm.latest).toHaveBeenLastCalledWith("@agentclientprotocol/codex-acp", "preview");
  expect(npm.install.mock.calls.at(-1)?.[1]).toBe("@agentclientprotocol/codex-acp@2.0.0-preview.3");
  // Deleting the agent keeps the choice for a later reinstall.
  await installations.uninstall("codex", v2);
  expect(await installations.protocol("codex")).toBe("v2");
});

it("keeps API-key credentials by default and withholds them when the provider should use its own sign-in", async () => {
  const { installations } = await fixture(["1.0.0"]);
  const claude = { ...spec, credentialEnv: ["VIBE_TEST_API_KEY", "VIBE_TEST_AUTH_TOKEN"] };
  const previous = process.env.VIBE_TEST_API_KEY;
  process.env.VIBE_TEST_API_KEY = "secret";
  try {
    expect(await installations.state("claude", claude)).toMatchObject({ credentials: "environment", credentialVariables: ["VIBE_TEST_API_KEY", "VIBE_TEST_AUTH_TOKEN"], credentialVariablesSet: ["VIBE_TEST_API_KEY"] });
    expect(JSON.stringify(await installations.state("claude", claude))).not.toContain("secret");
    expect(await installations.withheldEnv("claude", claude)).toEqual([]);
    await installations.setProtocol("claude", "v2");
    await installations.setCredentials("claude", "login");
    expect(await installations.withheldEnv("claude", claude)).toEqual(["VIBE_TEST_API_KEY", "VIBE_TEST_AUTH_TOKEN"]);
    // Both choices are kept together.
    expect(await installations.protocol("claude")).toBe("v2");
    expect(await installations.withheldEnv("codex", spec)).toEqual([]);
  } finally { if (previous === undefined) delete process.env.VIBE_TEST_API_KEY; else process.env.VIBE_TEST_API_KEY = previous; }
});
