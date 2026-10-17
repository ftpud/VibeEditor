import { describe, expect, it } from "vitest";
import { takeUnfetchedText, type FetchCursors } from "./workflow-fetch.js";

describe("takeUnfetchedText", () => {
  it("returns only appended text and reports unchanged", () => {
    const cursors: FetchCursors = new Map();
    expect(takeUnfetchedText(cursors, "k", "one\n")).toEqual({ text: "one\n", hasMore: false, gap: false });
    expect(takeUnfetchedText(cursors, "k", "one\ntwo\n")).toEqual({ text: "two\n", hasMore: false, gap: false });
    expect(takeUnfetchedText(cursors, "k", "one\ntwo\n")).toMatchObject({ text: "" });
  });

  it("keeps cursors independent per key and handles repeated lines", () => {
    const cursors: FetchCursors = new Map();
    takeUnfetchedText(cursors, "a", "ok\n");
    expect(takeUnfetchedText(cursors, "a", "ok\nok\nok\n").text).toBe("ok\nok\n");
    expect(takeUnfetchedText(cursors, "b", "ok\nok\nok\n").text).toBe("ok\nok\nok\n");
  });

  it("follows a rolling buffer and flags rolled-off data", () => {
    const cursors: FetchCursors = new Map();
    const first = "a".repeat(1500) + "END1";
    takeUnfetchedText(cursors, "k", first);
    expect(takeUnfetchedText(cursors, "k", first.slice(300) + "more")).toMatchObject({ text: "more", gap: false });
    expect(takeUnfetchedText(cursors, "k", "z".repeat(50))).toMatchObject({ text: "z".repeat(50), gap: true });
  });

  it("pages large unfetched text", () => {
    const cursors: FetchCursors = new Map();
    const text = "x".repeat(20_000);
    let total = 0;
    let page = takeUnfetchedText(cursors, "k", text);
    expect(page.hasMore).toBe(true);
    for (total = page.text.length; page.hasMore; total += page.text.length) page = takeUnfetchedText(cursors, "k", text);
    expect(total).toBe(20_000);
    expect(takeUnfetchedText(cursors, "k", text).text).toBe("");
  });
});
