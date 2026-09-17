import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: vi.fn() }, dialog: {}, ipcMain: { handle: vi.fn() } }));
let helpers: typeof import("./project-transfer.js");
beforeAll(async () => { helpers = await import("./project-transfer.js"); });

describe("Electron project transfer validation", () => {
  it("accepts only bounded structured start requests", () => { expect(helpers.validateStart({ localId: "local", token: "ticket", host: "127.0.0.1", port: 9000, direction: "upload", size: 12 })).toMatchObject({ size: 12 }); expect(() => helpers.validateStart({ localId: "local", token: "ticket", host: "host", port: 9000, direction: "upload", size: -1 })).toThrow("Invalid transfer"); });
  it("rejects host strings that could alter the transfer URL", () => { expect(helpers.encodeHost("::1")).toBe("[::1]"); expect(() => helpers.encodeHost("host/path")).toThrow("Invalid Core host"); });
  it("maps cancellation and oversized channel closes to actionable errors", () => { expect(helpers.safeTransferError(4000, "")).toBe("Transfer cancelled"); expect(helpers.safeTransferError(1009, "")).toContain("size limit"); });
  it("expires abandoned local path choices and consumes used choices once", () => { vi.useFakeTimers(); try { const store = new helpers.LocalChoiceStore(100); const used = store.put({ path: "/local/used", direction: "upload" }); expect(store.take(used)).toMatchObject({ path: "/local/used" }); expect(store.take(used)).toBeUndefined(); const abandoned = store.put({ path: "/local/abandoned", direction: "download" }); vi.advanceTimersByTime(101); expect(store.take(abandoned)).toBeUndefined(); } finally { vi.useRealTimers(); } });
});
