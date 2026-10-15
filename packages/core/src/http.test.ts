import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHttpRequest } from "./http.js";

describe("executeHttpRequest", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends headers and body and captures the response", async () => {
    const fetchMock = vi.fn(async () => new Response("created", { status: 201, statusText: "Created", headers: { "x-result": "yes" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeHttpRequest("POST", "https://example.test/items", { "x-test": "yes", "content-type": "text/plain" }, "payload");
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://example.test/items"), expect.objectContaining({ method: "POST", headers: { "x-test": "yes", "content-type": "text/plain" }, body: "payload" }));
    expect(result.status).toBe(201); expect(result.headers["x-result"]).toBe("yes"); expect(result.body).toBe("created");
  });

  it("rejects unsupported URL protocols", async () => {
    await expect(executeHttpRequest("GET", "file:///etc/passwd", {})).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("cancels an oversized stream before consuming the remaining response", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel,
    }, { highWaterMark: 0 });
    const response = new Response(stream);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(executeHttpRequest("GET", "https://example.test/large", {})).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts a response exactly at the limit and handles empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a".repeat(2 * 1024 * 1024))));
    expect((await executeHttpRequest("GET", "https://example.test/limit", {})).body.length).toBe(2 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect((await executeHttpRequest("GET", "https://example.test/empty", {})).body).toBe("");
  });

});
