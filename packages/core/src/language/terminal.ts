import path from "node:path";
import type { TerminalSessionSnapshot } from "@remote-ide/protocol";
import { CoreError } from "../errors.js";
import type { TerminalSessionHost } from "../process-manager.js";
import type { LanguageService } from "./service.js";

const active = new WeakMap<TerminalSessionHost, Map<string, LanguageService>>();
const key = (workspace: string, language: string) => JSON.stringify([path.resolve(workspace), language]);
export function hasLanguageTerminalRun(terminals: TerminalSessionHost, workspace: string, language: string): boolean {
  return active.get(terminals)?.has(key(workspace, language)) ?? false;
}
export function stopLanguageTerminalRun(terminals: TerminalSessionHost, workspace: string, language: string): boolean {
  const service = active.get(terminals)?.get(key(workspace, language));
  service?.stop();
  return !!service;
}

/** Plugins prepare launch arguments; Core owns the interactive PTY and replay. */
export async function runLanguageInTerminal(service: LanguageService, terminals: TerminalSessionHost, workspace: string): Promise<{ terminal: TerminalSessionSnapshot }> {
  if (!service.runInTerminal) throw new CoreError("INVALID_REQUEST", `${service.descriptor.name} does not support terminal run configurations`);
  const runs = active.get(terminals) ?? new Map<string, LanguageService>(); active.set(terminals, runs);
  const runKey = key(workspace, service.descriptor.id);
  if (runs.has(runKey)) throw new CoreError("INVALID_REQUEST", "A run configuration is already running for this language");
  runs.set(runKey, service);
  let terminal: TerminalSessionSnapshot | undefined;
  try {
    await service.runInTerminal((spec) => {
      let finish!: (code: number) => void;
      const completion = new Promise<number>((resolve) => { finish = resolve; }).then((code) => { runs.delete(runKey); return code; });
      const created = terminals.create(workspace, 80, 24, spec.cwd ?? workspace, spec.name ?? `${service.descriptor.name} Run`, { command: spec.command, args: spec.args, env: spec.env, onExit: finish });
      terminal = created;
      return { completion, stop: () => {
        if (terminals.attach(workspace, created.terminalId)?.status === "running") terminals.terminate(workspace, created.terminalId);
      } };
    });
    if (!terminal) throw new CoreError("INVALID_REQUEST", "The language plugin did not create a run terminal");
    return { terminal };
  } catch (error) {
    runs.delete(runKey);
    if (terminal) terminals.close(workspace, terminal.terminalId);
    throw error;
  }
}
