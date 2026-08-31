import { describe, expect, it, vi } from "vitest";
import { TerminalSessionHost, type TerminalPtyFactory } from "./process-manager.js";

class FakePty {
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  dataListeners = 0;
  exitListeners = 0;
  private onDataListener?: (data: string) => void;
  private onExitListener?: (event: { exitCode: number; signal?: number }) => void;

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): { dispose(): void } { this.dataListeners += 1; this.onDataListener = listener; return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } { this.exitListeners += 1; this.onExitListener = listener; return { dispose() {} }; }
  emitData(data: string): void { this.onDataListener?.(data); }
  emitExit(exitCode: number): void { this.onExitListener?.({ exitCode }); }
}

function setup() {
  const ptys: FakePty[] = [];
  const factory: TerminalPtyFactory = vi.fn(() => { const pty = new FakePty(); ptys.push(pty); return pty; });
  const events: unknown[] = [];
  return { host: new TerminalSessionHost((event) => events.push(event), factory), ptys, factory, events };
}

describe("TerminalSessionHost", () => {
  it("keeps one PTY alive across task switches and renderer reconnections", () => {
    const { host, ptys, factory } = setup();
    const created = host.create("/workspace/task-a", 80, 24);
    ptys[0]!.emitData("before switch\r\n");

    // Leaving a task and losing a renderer socket do not call a lifecycle method on the host.
    expect(host.attach("/workspace/task-a", created.terminalId)).toMatchObject({ terminalId: created.terminalId, status: "running", output: "before switch\r\n" });
    expect(host.attach("/workspace/task-a", created.terminalId)).toMatchObject({ terminalId: created.terminalId, status: "running" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ptys[0]!.dataListeners).toBe(1);
    expect(ptys[0]!.exitListeners).toBe(1);
  });

  it("cleans up an explicitly closed terminal", () => {
    const { host, ptys } = setup();
    const terminal = host.create("/workspace/task-a", 80, 24);
    host.close("/workspace/task-a", terminal.terminalId);
    expect(ptys[0]!.killed).toBe(true);
    expect(host.attach("/workspace/task-a", terminal.terminalId)).toBeUndefined();
    ptys[0]!.emitData("late output");
    expect(host.attach("/workspace/task-a", terminal.terminalId)).toBeUndefined();
  });

  it("reports stale sessions as unavailable without creating a replacement PTY", () => {
    const { host, factory } = setup();
    expect(host.attach("/workspace/task-a", "00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("isolates session ids and streams between task worktrees", () => {
    const { host, ptys } = setup();
    const first = host.create("/workspace/task-a", 80, 24);
    const second = host.create("/workspace/task-b", 80, 24);
    ptys[0]!.emitData("task a secret");

    expect(host.attach("/workspace/task-b", first.terminalId)).toBeUndefined();
    expect(() => host.input("/workspace/task-b", first.terminalId, "wrong task")).toThrow("Terminal not found");
    expect(host.attach("/workspace/task-b", second.terminalId)?.output).toBe("");
    expect(ptys[0]!.writes).toEqual([]);
  });

  it("removes only the deleted task's sessions and preserves exited metadata until close", () => {
    const { host, ptys } = setup();
    const task = host.create("/workspace/task-a", 80, 24);
    const root = host.create("/workspace/root", 80, 24);
    ptys[0]!.emitExit(7);
    expect(host.attach("/workspace/task-a", task.terminalId)).toMatchObject({ status: "exited", exitCode: 7 });

    host.closeWorkspace("/workspace/task-a");
    expect(host.attach("/workspace/task-a", task.terminalId)).toBeUndefined();
    expect(host.attach("/workspace/root", root.terminalId)?.status).toBe("running");
    expect(ptys[1]!.killed).toBe(false);
  });

  it("retains an exit code for an exited process rather than presenting it as a live reattach", () => {
    const { host, ptys, factory } = setup();
    const terminal = host.create("/workspace/task-a", 80, 24);
    ptys[0]!.emitExit(23);

    expect(host.attach("/workspace/task-a", terminal.terminalId)).toMatchObject({ status: "exited", exitCode: 23 });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
