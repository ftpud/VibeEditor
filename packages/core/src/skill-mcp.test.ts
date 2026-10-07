import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { skillToolServer } from "./app-tools.js";
import { SkillsStore } from "./skills.js";

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
  const finished = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
  try {
    child.stdin.end([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "configuration_list", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skill_load", arguments: { id: "local/review" } } }
    ].map((request) => JSON.stringify(request)).join("\n") + "\n");
    let commands: string[] = [];
    for (let attempt = 0; !commands.length && attempt < 200; attempt++) { commands = await readdir(owner.commandsDirectory); if (!commands.length) await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect(commands).toHaveLength(1);
    await owner.consumeCommand(path.join(owner.commandsDirectory, commands[0]!), async (command) => {
      expect(command.currentProvider).toBe("codex"); expect(command.currentWorkspace).toBe(root); expect(command.name).toBe("skill_load");
      return store.load(root, command.args.id as string, session);
    });
    await finished;
    const responses = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["skill_load"]);
    expect(responses[1].result.isError).toBe(true);
    const loaded = JSON.parse(responses[2].result.content[0].text);
    expect(loaded.content).toBe("Instructions fetched only when needed."); expect(loaded.baseDirectory).toContain(path.join("skills", "local"));
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
}, 10_000);
