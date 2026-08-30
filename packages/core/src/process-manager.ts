import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { CoreError } from "./errors.js";

const MAX_REPLAY_LENGTH = 1_000_000;

export type TerminalEvent =
  | { type: "output"; workspace: string; terminalId: string; data: string }
  | { type: "exit"; workspace: string; terminalId: string; exitCode: number };

export type TerminalSnapshot = { terminalId: string; status: "running" | "exited"; output: string; exitCode?: number };

type TerminalPty = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
export type TerminalPtyFactory = (cwd: string, cols: number, rows: number) => TerminalPty;
type TerminalSession = { id: string; workspace: string; pty?: TerminalPty; output: string; exitCode?: number };

/** Owns PTYs for the backend lifetime, independently of renderer sockets. */
export class TerminalSessionHost {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly onEvent: (event: TerminalEvent) => void,
    private readonly createPty: TerminalPtyFactory = defaultPtyFactory
  ) {}

  create(workspace: string, cols: number, rows: number, cwd = workspace): TerminalSnapshot {
    this.validateSize(cols, rows);
    const terminalId = crypto.randomUUID();
    const scopedWorkspace = path.resolve(workspace);
    try {
      const pty = this.createPty(path.resolve(cwd), cols, rows);
      const session: TerminalSession = { id: terminalId, workspace: scopedWorkspace, pty, output: "" };
      this.sessions.set(terminalId, session);
      pty.onData((data) => {
        if (this.sessions.get(terminalId) !== session) return;
        session.output = (session.output + data).slice(-MAX_REPLAY_LENGTH);
        this.onEvent({ type: "output", workspace: scopedWorkspace, terminalId, data });
      });
      pty.onExit(({ exitCode }) => {
        if (this.sessions.get(terminalId) !== session) return;
        session.pty = undefined;
        session.exitCode = exitCode;
        this.onEvent({ type: "exit", workspace: scopedWorkspace, terminalId, exitCode });
      });
      return this.snapshot(session);
    } catch (error) {
      throw new CoreError("TERMINAL_FAILED", `Could not start terminal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  attach(workspace: string, terminalId: string): TerminalSnapshot | undefined {
    const session = this.sessions.get(terminalId);
    return session && session.workspace === path.resolve(workspace) ? this.snapshot(session) : undefined;
  }

  input(workspace: string, terminalId: string, data: string): void {
    this.getRunning(workspace, terminalId).write(data);
  }

  resize(workspace: string, terminalId: string, cols: number, rows: number): void {
    this.validateSize(cols, rows);
    this.getRunning(workspace, terminalId).resize(cols, rows);
  }

  close(workspace: string, terminalId: string): void {
    const session = this.get(workspace, terminalId);
    this.sessions.delete(terminalId);
    session.pty?.kill();
  }

  /** Terminates a PTY while retaining its replay buffer and exit event for reconnect/attach. */
  terminate(workspace: string, terminalId: string): void {
    this.getRunning(workspace, terminalId).kill();
  }

  closeWorkspace(workspace: string): void {
    const scopedWorkspace = path.resolve(workspace);
    for (const session of [...this.sessions.values()]) {
      if (session.workspace !== scopedWorkspace) continue;
      this.sessions.delete(session.id);
      session.pty?.kill();
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.pty?.kill();
    this.sessions.clear();
  }

  private snapshot(session: TerminalSession): TerminalSnapshot {
    return { terminalId: session.id, status: session.pty ? "running" : "exited", output: session.output, ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}) };
  }

  private get(workspace: string, terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session || session.workspace !== path.resolve(workspace)) throw new CoreError("TERMINAL_FAILED", `Terminal not found: ${terminalId}`);
    return session;
  }

  private getRunning(workspace: string, terminalId: string): TerminalPty {
    const session = this.get(workspace, terminalId);
    if (!session.pty) throw new CoreError("TERMINAL_FAILED", `Terminal has exited: ${terminalId}`);
    return session.pty;
  }

  private validateSize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw new CoreError("INVALID_REQUEST", "Terminal cols and rows must be integers between 1 and 1000");
    }
  }
}

function defaultPtyFactory(cwd: string, cols: number, rows: number): TerminalPty {
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/sh");
  return spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } });
}
