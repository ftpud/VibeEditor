import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, watch } from "node:fs/promises";
import { expect, it } from "vitest";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { skillToolServer } from "./app-tools.js";
import { SkillsStore } from "./skills.js";

async function waitForBridgeCommand(directory: string, child: ChildProcess, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const watcher = watch(directory, { signal: controller.signal });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting ${timeoutMs}ms for the MCP bridge command`)), timeoutMs);
  });
  const closed = new Promise<never>((_resolve, reject) => child.once("close", (code, signal) => reject(new Error(`MCP server exited before publishing its bridge command (code ${code}, signal ${signal ?? "none"})`))));
  void closed.catch(() => undefined);
  try {
    while (true) {
      const commands = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      if (commands.length) return commands[0]!;
      await Promise.race([watcher.next(), timeout, closed]);
    }
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function waitForChildClose(closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([closed.then(() => undefined), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP server did not exit within ${timeoutMs}ms after stdin closed`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

it("loads selected skills over MCP and exposes only skill_load, using the owning Core bridge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-skill-mcp-"));
  const root = path.join(directory, "project"); const bridgeRoot = path.join(directory, "primary"); const state = path.join(directory, "state");
  await mkdir(root);
  const store = new SkillsStore(state, root);
  await store.write("local/review", root, "Instructions fetched only when needed.");
  const entries = await store.available(root, ["local/review"]);
  const session = { model: "test", reasoning: "", status: "in_progress" as const, messages: [], threadId: "thread", skillCatalogue: { threadId: "thread", entries } };
  const owner = new AppEventBridge(bridgeRoot, state, appBridgeInstanceId); await owner.ready();
  const server = skillToolServer(root, root, "codex", bridgeRoot);
  if (!("command" in server)) throw new Error("Expected stdio server");
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env, REMOTE_IDE_STATE_DIR: state }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  let childClosed = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { childClosed = true; resolve({ code, signal }); });
  });
  const finished = closed.then(({ code, signal }) => code === 0 ? undefined : Promise.reject(new Error(`MCP server exited with code ${code}, signal ${signal ?? "none"}: ${stderr}`)));
  void finished.catch(() => undefined);
  try {
    child.stdin.end([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "configuration_list", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skill_load", arguments: { id: "local/review" } } }
    ].map((request) => JSON.stringify(request)).join("\n") + "\n");
    const command = await waitForBridgeCommand(owner.commandsDirectory, child, 15_000);
    expect((await readdir(owner.commandsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await owner.consumeCommand(path.join(owner.commandsDirectory, command), async (command) => {
      expect(command.currentProvider).toBe("codex"); expect(command.currentWorkspace).toBe(root); expect(command.name).toBe("skill_load");
      return store.load(root, command.args.id as string, session);
    });
    await waitForChildClose(closed, 15_000);
    await finished;
    const responses = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["skill_load"]);
    expect(responses[1].result.isError).toBe(true);
    const loaded = JSON.parse(responses[2].result.content[0].text);
    expect(loaded.content).toBe("Instructions fetched only when needed."); expect(loaded.baseDirectory).toContain(path.join("skills", "local"));
  } finally {
    if (!childClosed) child.kill();
    if (!childClosed) {
      try { await waitForChildClose(closed, 5_000); }
      catch { child.kill("SIGKILL"); await closed.catch(() => undefined); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
