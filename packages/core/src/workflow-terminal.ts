import crypto from "node:crypto";
import type { AiSession } from "@remote-ide/protocol";
import { TerminalSessionHost } from "./process-manager.js";

/** Operates only on terminals owned by the bound workflow workspace. */
export function executeTerminalControl(input: string, workspace: string, host: TerminalSessionHost, assertActive: () => void): AiSession {
  assertActive();
  const request: unknown = input.trim() ? JSON.parse(input) : { action: "list" };
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Terminal Control needs a JSON object");
  const args = request as Record<string, unknown>;
  let result: unknown;
  if (args.action === "list") {
    result = { terminals: host.list(workspace).map(({ output, ...session }) => session) };
  } else if (args.action === "open" || args.action === "open_and_run") {
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 120 || /[\x00-\x1f]/.test(args.name)) throw new Error("Terminal tab name must be 1 to 120 characters");
    let command: string | undefined;
    if (args.action === "open_and_run") {
      if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 100_000 || args.command.includes("\0")) throw new Error("command must be a nonempty string of at most 100000 characters without null bytes");
      command = /[\r\n]$/.test(args.command) ? args.command : `${args.command}\n`;
    }
    const terminal = host.create(workspace, 100, 30, workspace, args.name.trim());
    if (command !== undefined) {
      try { host.input(workspace, terminal.terminalId, command); }
      catch (error) { host.close(workspace, terminal.terminalId); throw error; }
    }
    result = terminal;
  } else if (args.action === "read" || args.action === "write") {
    if (typeof args.terminal_id !== "string") throw new Error("terminal_id is required");
    const terminal = host.attach(workspace, args.terminal_id);
    if (!terminal) throw new Error("Terminal not found in this workspace");
    if (args.action === "write") {
      if (typeof args.data !== "string" || args.data.length > 100_000) throw new Error("data must be a string of at most 100000 characters");
      host.input(workspace, args.terminal_id, args.data);
      result = { terminalId: terminal.terminalId, status: terminal.status, written: args.data.length };
    } else {
      const lines = args.lines ?? 100;
      if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 10_000) throw new Error("lines must be an integer from 1 to 10000");
      const entries = terminal.output.replace(/\r\n/g, "\n").split("\n");
      if (entries.at(-1) === "") entries.pop();
      const output = entries.slice(-lines).join("\n");
      result = { ...terminal, output: output.slice(-30_000), truncated: output.length > 30_000 };
    }
  } else throw new Error("Terminal Control action must be list, open, open_and_run, read, or write");
  return { id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] } as AiSession;
}
