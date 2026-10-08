import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("advertises typed workflow tools over the real MCP transport", async () => {
  const replies = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./app-tools.ts", import.meta.url))], {
      env: { ...process.env, VIBE_EDITOR_ROOT_WORKSPACE: os.tmpdir(), VIBE_EDITOR_CURRENT_WORKSPACE: os.tmpdir(), VIBE_EDITOR_WORKFLOW_RUN_ID: "run", VIBE_EDITOR_WORKFLOW_BLOCK_ID: "agent", VIBE_EDITOR_FLOW_TOOLS: "1" }, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(error)));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
  const messages = replies.trim().split("\n").map((line) => JSON.parse(line));
  expect(messages[0].result.capabilities).toEqual({ tools: {} });
  const tools = messages[1].result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["workflow_connections", "workflow_use_block", "workflow_choose_path"]));
  expect(tools.find((tool) => tool.name === "workflow_use_block")?.inputSchema.required).toEqual(["block_id", "input"]);
  expect(tools.map((tool) => tool.name)).not.toContain("workflow_run_stack");
});
