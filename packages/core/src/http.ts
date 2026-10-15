import type { HttpResponse } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function executeHttpRequest(method: string, rawUrl: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
  if (!/^[A-Z]+$/.test(method) || method.length > 16) throw new CoreError("INVALID_REQUEST", "Invalid HTTP method");
  let url: URL; try { url = new URL(rawUrl); } catch { throw new CoreError("INVALID_REQUEST", "Invalid request URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CoreError("INVALID_REQUEST", "Only HTTP and HTTPS URLs are supported");
  if (Object.keys(headers).length > 100 || Object.entries(headers).some(([name, value]) => !name || name.length > 200 || typeof value !== "string" || value.length > 16_000)) throw new CoreError("INVALID_REQUEST", "Invalid request headers");
  if (body !== undefined && Buffer.byteLength(body) > 2 * 1024 * 1024) throw new CoreError("FILE_TOO_LARGE", "HTTP request body exceeds 2 MB");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000); const started = performance.now();
  try {
    const response = await fetch(url, { method, headers, ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}), signal: controller.signal, redirect: "follow" });
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new CoreError("FILE_TOO_LARGE", "HTTP response exceeds 2 MB");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const buffer = Buffer.concat(chunks, received);
    return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: buffer.toString("utf8"), durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("READ_FAILED", `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { clearTimeout(timeout); }
}
