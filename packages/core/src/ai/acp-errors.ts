import { setTimeout as delay } from "node:timers/promises";

/** Keep actionable stderr while removing the adapter's routine startup traces. */
export function cleanAcpDiagnostics(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*\[(?:session\/(?:create|query)|authStatus)\](?:\s|$)/.test(line)).join("\n").trim();
}

export function acpErrorText(error: unknown): string {
  const data = (error as { data?: { details?: unknown; message?: unknown } | string } | undefined)?.data;
  return [...new Set([error instanceof Error ? error.message : String(error), typeof data === "string" ? data : data?.details, typeof data === "object" ? data?.message : undefined].filter((part): part is string => typeof part === "string" && !!part.trim()))].join("\n");
}

export function isOAuthRefreshContention(error: unknown): boolean {
  const text = acpErrorText(error);
  return /failed to refresh oauth token/i.test(text) && /refreshing it|exited mid[- ]refresh|another[^\n]{0,100}process[^\n]*refresh/i.test(text);
}

/** Retry only refresh-lock contention, never generic authentication failures. */
export async function retryOAuthRefresh<T>(operation: () => Promise<T>, options: { signal: AbortSignal; delays: readonly number[]; canRetry(): boolean; onRetry?(milliseconds: number, attempt: number): Promise<void> }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      const milliseconds = options.delays[attempt];
      if (milliseconds === undefined || !isOAuthRefreshContention(error) || !options.canRetry()) throw error;
      await options.onRetry?.(milliseconds, attempt + 1);
      if (!options.canRetry()) throw error;
      await delay(milliseconds, undefined, { signal: options.signal });
      if (!options.canRetry()) throw error;
    }
  }
}
