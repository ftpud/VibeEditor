/** Per-caller record of the data a workflow block has already received through `fetch`. */
export type FetchCursor = { anchor: string; length: number } | string;
export type FetchCursors = Map<string, FetchCursor>;

const ANCHOR_CHARS = 1000;
export const FETCH_CHUNK_CHARS = 8000;

/** Bound the cursor table; the oldest entries are forgotten and simply delivered again. */
export function rememberFetch(cursors: FetchCursors, key: string, cursor: FetchCursor): void {
  cursors.delete(key);
  cursors.set(key, cursor);
  while (cursors.size > 2048) cursors.delete(cursors.keys().next().value!);
}

/**
 * Returns the part of an append-only (possibly rolling) text this caller has not received.
 * The cursor remembers the end of the delivered text, so rolled-off history is detected by
 * its anchor going missing; `gap` then reports that earlier unread data is no longer retained.
 */
export function takeUnfetchedText(cursors: FetchCursors, key: string, text: string): { text: string; hasMore: boolean; gap: boolean } {
  const cursor = cursors.get(key);
  let start = 0;
  let gap = false;
  if (typeof cursor === "object") {
    if (text.slice(cursor.length - cursor.anchor.length, cursor.length) === cursor.anchor) start = cursor.length;
    else {
      const at = text.indexOf(cursor.anchor);
      if (at >= 0) start = at + cursor.anchor.length;
      else gap = true;
    }
  }
  const end = Math.min(text.length, start + FETCH_CHUNK_CHARS);
  if (end > 0 && (end > start || typeof cursor !== "object" || gap)) rememberFetch(cursors, key, { anchor: text.slice(Math.max(0, end - ANCHOR_CHARS), end), length: end });
  return { text: text.slice(start, end), hasMore: end < text.length, gap };
}
