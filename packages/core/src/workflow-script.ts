import crypto from "node:crypto";
import { workspaceShellCommand } from "./workspace-shell.js";
import { spawn } from "node:child_process";
import type { AiSession, HarnessBlock } from "@remote-ide/protocol";

export async function executeFlowScript(block: HarnessBlock, input: string, workspace: string, assertActive: () => void): Promise<AiSession> {
  assertActive();
  const output = await new Promise<string>((resolve, reject) => {
    const { shell, args } = workspaceShellCommand(block.command!);
    const child = spawn(shell, args, { cwd: workspace, env: { ...globalThis.process.env, TERM: "xterm-256color", COLORTERM: "truecolor", VIBE_WORKFLOW_INPUT: input }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; let failure: unknown;
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
    const check = setInterval(() => { try { assertActive(); } catch (error) { failure = error; stop(); } }, 100);
    const timeout = setTimeout(() => { failure = new Error("Script timed out after 30 minutes"); stop(); }, 30 * 60_000);
    const cleanup = () => { clearInterval(check); clearTimeout(timeout); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => { cleanup(); if (failure) reject(failure); else if (code !== 0) reject(new Error(`Script exited with ${code}: ${stderr}`)); else resolve(stdout); });
  });
  assertActive();
  return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: output, timestamp: new Date().toISOString() }] } as AiSession;
}
