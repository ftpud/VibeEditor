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
});
