import type { ServerEvent } from "@remote-ide/protocol";
import { CoalescedAsyncAction } from "./client";

type Guard = () => boolean;
export type InvalidationScope = { rootId: string; workspace: string; revision: number };
export type InvalidationActions = {
  configuration: Array<(canApply: Guard) => Promise<void>>;
  processes: (canApply: Guard) => Promise<void>;
  configurationFailed: (error: unknown) => void;
};

/** Two bounded snapshot channels owned by one connection; no mutation or stream queue. */
export class InvalidationRefreshes {
  private configuration?: CoalescedAsyncAction;
  private processes?: CoalescedAsyncAction;
  private scope?: InvalidationScope;
  private disposed = false;
  constructor(private readonly currentScope: () => InvalidationScope | undefined, private readonly actions: InvalidationActions) {}

  reset(): void {
    this.configuration?.dispose(); this.processes?.dispose();
    this.configuration = undefined; this.processes = undefined; this.scope = undefined;
  }
  dispose(): void { this.disposed = true; this.reset(); }

  refreshConfiguration(): void {
    const scope = this.currentScope();
    if (scope) this.handle({ type: "configuration.changed", payload: { rootId: scope.rootId, global: false, resource: "selection" } });
  }

  handle(event: ServerEvent): boolean {
    if (event.type !== "configuration.changed" && event.type !== "processes.changed") return false;
    const scope = this.currentScope();
    if (this.disposed || !scope) return true;
    if (event.type === "configuration.changed" && !event.payload.global && event.payload.rootId !== scope.rootId) return true;
    if (!this.scope || !sameScope(scope, this.scope)) {
      this.reset(); this.scope = scope;
      const guarded = (alive: Guard): Guard => () => {
        const current = this.currentScope();
        return alive() && !this.disposed && !!current && sameScope(scope, current);
      };
      this.configuration = new CoalescedAsyncAction(async (alive) => {
        const canApply = guarded(alive); if (!canApply()) return;
        // Promise.all would release the batch on its first error while sibling reads still run.
        const results = await Promise.allSettled(this.actions.configuration.map((refresh) => refresh(canApply)));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected" && canApply()) this.actions.configurationFailed(failed.reason);
      });
      this.processes = new CoalescedAsyncAction(async (alive) => {
        const canApply = guarded(alive); if (canApply()) await this.actions.processes(canApply);
      });
    }
    if (event.type === "configuration.changed") this.configuration!.trigger();
    else this.processes!.trigger();
    return true;
  }
  async whenIdle(): Promise<void> { await Promise.all([this.configuration?.whenIdle(), this.processes?.whenIdle()]); }
}

function sameScope(left: InvalidationScope, right: InvalidationScope): boolean {
  return left.rootId === right.rootId && left.workspace === right.workspace && left.revision === right.revision;
}
