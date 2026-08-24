import crypto from "node:crypto";
import os from "node:os";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { CoreError } from "./errors.js";

export type TerminalEvent =
  | { type: "output"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number };

export interface ProcessManager {
  create(cols: number, rows: number): string;
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  closeAll(): void;
}

export class PtyProcessManager implements ProcessManager {
  private readonly terminals = new Map<string, IPty>();

  constructor(
    private readonly cwd: string,
    private readonly onEvent: (event: TerminalEvent) => void
  ) {}

  create(cols: number, rows: number): string {
    this.validateSize(cols, rows);
    const terminalId = crypto.randomUUID();
    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/sh");
    try {
      const terminal = spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
      });
      this.terminals.set(terminalId, terminal);
      terminal.onData((data) => this.onEvent({ type: "output", terminalId, data }));
      terminal.onExit(({ exitCode }) => {
        this.terminals.delete(terminalId);
        this.onEvent({ type: "exit", terminalId, exitCode });
      });
      return terminalId;
    } catch (error) {
      throw new CoreError("TERMINAL_FAILED", `Could not start terminal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  input(terminalId: string, data: string): void {
    this.get(terminalId).write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.validateSize(cols, rows);
    this.get(terminalId).resize(cols, rows);
  }

  close(terminalId: string): void {
    const terminal = this.get(terminalId);
    this.terminals.delete(terminalId);
    terminal.kill();
  }

  closeAll(): void {
    for (const terminal of this.terminals.values()) terminal.kill();
    this.terminals.clear();
  }

  private get(terminalId: string): IPty {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new CoreError("TERMINAL_FAILED", `Terminal not found: ${terminalId}`);
    return terminal;
  }

  private validateSize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw new CoreError("INVALID_REQUEST", "Terminal cols and rows must be integers between 1 and 1000");
    }
  }
}
