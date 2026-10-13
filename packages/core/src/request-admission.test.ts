import { describe, expect, it } from "vitest";
import { RequestAdmission, requestAdmissionLimit } from "./request-admission.js";

describe("per-connection request admission", () => {
  it("validates limits", () => {
    expect(requestAdmissionLimit()).toBe(32);
    for (const maxInFlight of [0, -1, 1.2, NaN, Infinity]) expect(() => requestAdmissionLimit({ maxInFlight })).toThrow();
  });
  it("rejects without queueing and releases success and error slots idempotently", async () => {
    const peer = new RequestAdmission(2); const healthy = new RequestAdmission(2);
    const first = peer.acquire(); const second = peer.acquire();
    expect(() => peer.acquire()).toThrow("not started");
    expect(healthy.acquire()).toBeTypeOf("function");
    first(); first(); expect(peer.inFlight).toBe(1);
    const errorSlot = peer.acquire();
    try { throw new Error("operation failed"); } catch {} finally { errorSlot(); }
    second(); expect(peer.inFlight).toBe(0);
    expect(peer.acquire()).toBeTypeOf("function");
  });
  it("clears slots on shutdown and blocks late work even before close event", () => {
    let open = true;
    const peer = new RequestAdmission(1, () => open); const release = peer.acquire();
    open = false; expect(() => peer.assertOpen()).toThrow("closed");
    peer.close(); peer.close(); release(); expect(peer.inFlight).toBe(0);
    expect(() => peer.acquire()).toThrow("closed");
  });
});
