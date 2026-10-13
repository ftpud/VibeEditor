import { CoreError } from "./errors.js";

export type RequestAdmissionOptions = { maxInFlight?: number };
export function requestAdmissionLimit(options: RequestAdmissionOptions = {}): number {
  if (options.maxInFlight === undefined) return Infinity;
  const limit = options.maxInFlight;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("maxInFlight must be a positive safe integer");
  return limit;
}

/** No waiting queue: admitted handlers retain a slot across service/barrier waits. */
export class RequestAdmission {
  private readonly leases = new Set<() => void>();
  private closed = false;
  constructor(private readonly limit: number, private readonly isOpen: () => boolean = () => true) {}
  assertOpen(): void {
    if (this.closed || !this.isOpen()) throw new CoreError("INVALID_REQUEST", "Connection closed before operation started");
  }
  acquire(): () => void {
    this.assertOpen();
    if (this.leases.size >= this.limit) throw new CoreError("INVALID_REQUEST", "Core request concurrency limit reached; request was not started");
    const release = () => { this.leases.delete(release); };
    this.leases.add(release);
    return release;
  }
  close(): void { this.closed = true; this.leases.clear(); }
  get inFlight(): number { return this.leases.size; }
}
