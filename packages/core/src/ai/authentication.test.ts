import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { AcpAuthentication } from "./authentication.js";

const instances: AcpAuthentication[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.shutdown())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-auth-")); directories.push(workspace);
  const launch = vi.fn(async () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fake-auth-agent.mjs", import.meta.url))], env: { AUTH_FILE: path.join(workspace, "credential"), AUTH_LOG: path.join(workspace, "requests"), ...extra } }));
  const auth = new AcpAuthentication("fixture", launch); instances.push(auth);
  return { workspace, auth, launch };
}
it("deduplicates discovery and exposes only public authentication method metadata", async () => {
  const { workspace, auth, launch } = await fixture();
  const [first, second] = await Promise.all([auth.get(workspace, true), auth.get(workspace, true)]);
  expect(first).toEqual(second); expect(launch).toHaveBeenCalledTimes(1);
  expect(first.methods).toEqual([{ id: "browser", name: "Browser sign-in", type: "agent" }, { id: "terminal", name: "Device sign-in", type: "terminal" }]);
});
it("routes URL authentication through an explicit confirmation and clears transient output on success", async () => {
  const { workspace, auth } = await fixture();
  const started = await auth.start(workspace, "browser");
  await vi.waitFor(async () => expect((await auth.get(workspace)).awaitingConfirmation).toBe(true));
  expect((await auth.get(workspace)).url).toBe("https://example.com/login");
  await expect(auth.input(`${workspace}-other`, { requestId: started.requestId!, action: "accept" })).rejects.toThrow("no longer active");
  await auth.input(workspace, { requestId: started.requestId!, action: "accept" });
  await vi.waitFor(async () => expect((await auth.get(workspace)).status).toBe("authenticated"));
  const state = await auth.get(workspace);
  expect(state.output).toBeUndefined(); expect(state.requestId).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain("provider-owned-credential");
});
it("runs terminal methods interactively with advertised arguments and environment, then verifies a fresh ACP session", async () => {
  const { workspace, auth } = await fixture();
  const started = await auth.start(workspace, "terminal");
  await vi.waitFor(async () => expect((await auth.get(workspace)).output).toContain("Enter confirmation"));
  await auth.input(workspace, { requestId: started.requestId!, data: "yes\r" });
  await vi.waitFor(async () => expect((await auth.get(workspace)).status).toBe("authenticated"));
  const requests = await readFile(path.join(workspace, "requests"), "utf8");
  expect(requests).toContain("session/new"); expect(requests).not.toContain("authenticate");
});
it("rejects stale input after cancellation and permits a new attempt", async () => {
  const { workspace, auth } = await fixture();
  const first = await auth.start(workspace, "browser");
  await vi.waitFor(async () => expect((await auth.get(workspace)).awaitingConfirmation).toBe(true));
  await auth.input(workspace, { requestId: first.requestId!, action: "cancel" });
  await expect(auth.input(workspace, { requestId: first.requestId!, action: "accept" })).rejects.toThrow("no longer active");
  const second = await auth.start(workspace, "browser");
  expect(second.requestId).not.toBe(first.requestId);
  await vi.waitFor(async () => expect((await auth.get(workspace)).awaitingConfirmation).toBe(true));
});
it("rejects unadvertised methods without executing an authentication command", async () => {
  const { workspace, auth } = await fixture();
  await auth.start(workspace, "invented-command");
  await vi.waitFor(async () => expect((await auth.get(workspace)).error).toContain("did not advertise"));
  expect(await readFile(path.join(workspace, "requests"), "utf8")).toBe("initialize\n");
});
it("refuses unsafe browser schemes and never asks the client to open them", async () => {
  const { workspace, auth } = await fixture({ AUTH_URL: "file:///private/credential" });
  await auth.start(workspace, "browser");
  await vi.waitFor(async () => expect((await auth.get(workspace)).status).toBe("error"));
  expect((await auth.get(workspace)).url).toBeUndefined();
});
it("reports failed terminal login and prevents new processes after shutdown", async () => {
  const { workspace, auth } = await fixture();
  const started = await auth.start(workspace, "terminal");
  await vi.waitFor(async () => expect((await auth.get(workspace)).output).toContain("Enter confirmation"));
  await auth.input(workspace, { requestId: started.requestId!, data: "no\r" });
  await vi.waitFor(async () => expect((await auth.get(workspace)).error).toContain("code 1"));
  await auth.shutdown();
  await expect(auth.start(workspace, "browser")).rejects.toThrow("shutting down");
});
