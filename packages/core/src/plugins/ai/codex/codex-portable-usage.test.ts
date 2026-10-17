import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexSessionManager } from "./index.js";
import { StdioAcpProvider } from "../../../ai/stdio-provider.js";
import { providerInstallations } from "../../../ai/provider-installations.js";
import { readCodexAccountQuota } from "./codex-usage.js";

vi.mock("./codex-usage.js", () => ({ readCodexAccountQuota: vi.fn() }));
const usage = { supported: true, label: "Context window", used: 120, limit: 1000, unit: "tokens" };
const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_PATH", undefined);
  vi.stubEnv("CODEX_ACP_COMMAND", undefined);
  vi.spyOn(StdioAcpProvider.prototype, "usage").mockResolvedValue(usage);
  vi.mocked(readCodexAccountQuota).mockResolvedValue({ plan: "test" });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("returns usage without installing anything when Codex is not installed", async () => {
  const install = vi.spyOn(providerInstallations, "install");
  vi.spyOn(providerInstallations, "entry").mockResolvedValue(undefined);
  await expect(new CodexSessionManager({ onChanged: () => {} }).usage("/workspace")).resolves.toEqual(usage);
  expect(install).not.toHaveBeenCalled();
  expect(readCodexAccountQuota).not.toHaveBeenCalled();
});
it("reads quota from the installed adapter's nested compatible CLI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-quota-runtime-")); directories.push(directory);
  const adapter = path.join(directory, "node_modules/@agentclientprotocol/codex-acp");
  const entry = path.join(adapter, "dist/index.js");
  const cli = path.join(adapter, "node_modules/@openai/codex/bin/codex.js");
  for (const file of [entry, cli]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, ""); }
  vi.spyOn(providerInstallations, "entry").mockResolvedValue(entry);
  await expect(new CodexSessionManager({ onChanged: () => {} }).usage("/workspace")).resolves.toEqual({ ...usage, accountQuota: { plan: "test" } });
  expect(readCodexAccountQuota).toHaveBeenCalledWith(process.execPath, [await realpath(cli), "app-server", "--stdio"]);
});
it("honors the explicit Codex executable for quota checks", async () => {
  vi.stubEnv("CODEX_PATH", "/custom/codex");
  await new CodexSessionManager({ onChanged: () => {} }).usage("/workspace");
  expect(readCodexAccountQuota).toHaveBeenCalledWith("/custom/codex", ["app-server", "--stdio"]);
});
it("preserves context usage when quota probing fails", async () => {
  vi.stubEnv("CODEX_PATH", "/missing/codex");
  vi.mocked(readCodexAccountQuota).mockRejectedValue(new Error("unavailable"));
  await expect(new CodexSessionManager({ onChanged: () => {} }).usage("/workspace")).resolves.toEqual(usage);
});
