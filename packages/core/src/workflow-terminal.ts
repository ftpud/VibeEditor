import crypto from "node:crypto";
import type { AiSession } from "@remote-ide/protocol";
import { TerminalSessionHost, type TerminalSnapshot } from "./process-manager.js";

const result = (value: unknown) => ({ id: crypto.randomUUID(), status: "idle", messages: [{ id: crypto.randomUUID(), role: "assistant", text: JSON.stringify(value), timestamp: new Date().toISOString() }] } as AiSession);

/** Like executeTerminalControl, but also supports run_and_wait, which holds the call until the command finishes. */
export async function executeTerminalControlAsync(input: string, workspace: string, host: TerminalSessionHost, assertActive: () => void): Promise<AiSession> {
  assertActive();
  let request: unknown;
  try { request = input.trim() ? JSON.parse(input) : undefined; } catch { /* The synchronous path reports invalid input. */ }
  if (!request || typeof request !== "object" || (request as { action?: unknown }).action !== "run_and_wait") return executeTerminalControl(input, workspace, host, assertActive);
  const args = request as Record<string, unknown>;
  if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 100_000 || args.command.includes("\0")) throw new Error("command must be a nonempty string of at most 100000 characters without null bytes");
  const timeoutMs = args.timeout_ms === undefined ? 300_000 : args.timeout_ms;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("timeout must be greater than zero and at most 86400 seconds");
  let terminal: TerminalSnapshot | undefined;
  if (args.terminal_id !== undefined) {
    if (typeof args.terminal_id !== "string") throw new Error("terminal_id must be a string");
    terminal = host.attach(workspace, args.terminal_id);
    if (!terminal) throw new Error("Terminal not found in this workspace");
    if (terminal.status !== "running") throw new Error("Terminal has already exited");
  } else {
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 120 || /[\x00-\x1f]/.test(args.name)) throw new Error("Terminal tab name must be 1 to 120 characters");
    terminal = host.create(workspace, 100, 30, workspace, args.name.trim());
  }
  const terminalId = terminal.terminalId;
  const marker = `__VIBE_DONE_${crypto.randomUUID().replaceAll("-", "")}_`;
  const done = new RegExp(`${marker}(-?\\d+)__`);
  const before = terminal.output.length;
  // The marker is only assembled by printf, so the shell's echo of this line never matches.
  try { host.input(workspace, terminalId, `{\n${args.command.replace(/[\r\n]+$/, "")}\n}; printf '\\n${marker}%s__\\n' "$?"\n`); }
  catch (error) { if (args.terminal_id === undefined) host.close(workspace, terminalId); throw error; }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertActive();
    const snapshot = host.attach(workspace, terminalId);
    if (!snapshot) throw new Error("Terminal was closed while the command was running");
    const text = snapshot.output.replace(/\r\n/g, "\n");
    const match = done.exec(text);
    const finished = (status: string, extra: Record<string, unknown>, end: number) => {
      const output = text.slice(text.length >= before ? before : 0, end).replace(/\n+$/, "");
      return result({ terminalId, status, ...extra, output: output.slice(-30_000), truncated: output.length > 30_000 });
    };
    if (match) return finished("completed", { exitCode: Number(match[1]) }, match.index);
    if (snapshot.status === "exited") return finished("exited", { exitCode: snapshot.exitCode ?? null }, text.length);
    if (Date.now() >= deadline) return finished("timed_out", { message: "The command is still running in the terminal; use read or fetch with terminal_id to follow it." }, text.length);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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
