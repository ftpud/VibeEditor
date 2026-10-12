import type { CoreClient } from "./client";

/** Owns one recovery attempt loop, including its retry timer. */
export class ConnectionRecovery {
  private controller?: AbortController;

  constructor(
    private readonly attempt: (signal: AbortSignal) => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly initialDelayMs = 250,
    private readonly maximumDelayMs = 5_000
  ) {}

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private async run(controller: AbortController): Promise<void> {
    const { signal } = controller;
    let delay = this.initialDelayMs;
    try {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, delay);
          signal.addEventListener("abort", finish, { once: true });
        });
        if (signal.aborted) return;
        try {
          await this.attempt(signal);
          return;
        } catch (error) {
          if (signal.aborted) return;
          this.failed(error);
          delay = Math.min(delay * 2, this.maximumDelayMs);
        }
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

/** Rebuilds connection-level root routing and filesystem watch subscription. */
export type RecoverySelection = { rootId: string; workspace: string; taskId?: string };

export async function reconnectWorkspace(client: CoreClient, host: string, port: number, includeIgnored: boolean, signal: AbortSignal, expected: RecoverySelection) {
  const check = () => { if (signal.aborted) throw new Error("Recovery cancelled"); };
  check();
  await client.connect(host, port);
  check();
  const roots = await client.request("workspace.roots", {});
  check();
  if (roots.selectedRootId !== expected.rootId) throw new Error("Saved workspace root is unavailable");
  const workspace = await client.request("workspace.open", { includeIgnored });
  check();
  if (workspace.workspace !== expected.workspace) throw new Error(`Saved workspace is unavailable: expected ${expected.workspace}, received ${workspace.workspace}`);
  const tasks = await client.request("tasks.list", {});
  check();
  if (tasks.selectedTaskId !== expected.taskId) throw new Error(`Saved task selection is unavailable: ${expected.taskId ?? "project root"}`);
  return { roots, workspace };
}

export async function restoreTerminal(client: CoreClient, terminalId: string | undefined, recovery: boolean) {
  const attached = terminalId ? await client.request("terminal.attach", { terminalId }) : undefined;
  if (attached?.state === "available") return { session: attached.session, reattached: true };
  if (recovery) throw new Error("Terminal session unavailable after reconnect");
  return { session: await client.request("terminal.create", { cols: 80, rows: 24 }), reattached: false };
}
