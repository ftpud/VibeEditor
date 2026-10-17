import { describe, expect, it } from "vitest";
import type { HarnessBlock, HarnessBlockRun } from "@remote-ide/protocol";
import { useMeeting } from "./workflow-meeting.js";

const agent = (id: string): HarnessBlock => ({ id, label: id, type: "ai", provider: "claude", model: "sonnet", prompt: "", position: { x: 0, y: 0 } });
const room = (): HarnessBlockRun => ({ blockId: "meeting", status: "queued" });

describe("Meeting transcript", () => {
  it("keeps independent cursors, supports replay and recent tails, and survives serialization", () => {
    const state = room();
    const publish = (text: string) => useMeeting(state, agent("a"), { action: "publish", message: text });
    publish("First"); publish("Second"); publish("Third");
    expect(useMeeting(state, agent("a"), { action: "diff", lines: 1 })).toMatchObject({ messages: [{ sequence: 1, author: "a", model: "sonnet", text: "First" }], cursor: 1, hasMore: true });
    expect(useMeeting(state, agent("b"), { action: "diff", lines: 2 })).toMatchObject({ messages: [{ sequence: 1 }, { sequence: 2 }], cursor: 2 });
    const restored = JSON.parse(JSON.stringify(state));
    expect(useMeeting(restored, agent("a"), {})).toMatchObject({ messages: [{ sequence: 2 }, { sequence: 3 }], cursor: 3, hasMore: false });
    expect(useMeeting(restored, agent("a"), {})).toMatchObject({ messages: [], hasMore: false });
    expect(useMeeting(restored, agent("a"), { action: "diff", after: 0, lines: 1 })).toMatchObject({ messages: [{ sequence: 1 }], hasMore: true });
    expect(restored.meeting.cursors.a).toBe(3);
    expect(useMeeting(state, agent("b"), { action: "tail", lines: 1 })).toMatchObject({ messages: [{ sequence: 3 }], cursor: 3 });
    expect(useMeeting(room(), agent("a"), {})).toMatchObject({ messages: [], latestSequence: 0 });
  });

  it("bounds pages without skipping unread messages and reports expired history", () => {
    const state = room();
    for (let i = 0; i < 1002; i++) useMeeting(state, agent("a"), { action: "publish", input: `Message ${i}` });
    expect(state.meeting?.messages).toHaveLength(1000);
    expect(useMeeting(state, agent("b"), { action: "diff", lines: 1 })).toMatchObject({ messages: [{ sequence: 3 }], historyTruncated: true, hasMore: true });
    const large = room();
    for (let i = 0; i < 3; i++) useMeeting(large, agent("a"), { action: "publish", message: "x".repeat(9000) });
    const first = useMeeting(large, agent("b"), {});
    expect(first).toMatchObject({ messages: [{ sequence: 1 }], cursor: 1, hasMore: true });
    expect(JSON.stringify(first).length).toBeLessThan(20000);
    expect(useMeeting(large, agent("b"), {})).toMatchObject({ messages: [{ sequence: 2 }] });
    expect(useMeeting(large, agent("c"), { action: "tail" })).toMatchObject({ messages: [{ sequence: 3 }], cursor: 3 });
  });

  it("validates actions and limits before changing the transcript", () => {
    const state = room();
    for (const args of [{ action: "erase" }, { action: "publish", message: " " }, { action: "publish", message: "x".repeat(10001) }, { action: "publish", message: "\u0000".repeat(10000) }, { lines: 0 }, { lines: 51 }, { after: -1 }, { after: 1 }, { action: "tail", after: 0 }]) expect(() => useMeeting(state, agent("a"), args)).toThrow();
    expect(state.meeting).toBeUndefined();
    useMeeting(state, agent("__proto__"), { action: "publish", message: "Hello" });
    expect(useMeeting(state, agent("__proto__"), {})).toMatchObject({ cursor: 1 });
    expect(Object.getPrototypeOf(state.meeting?.cursors)).toBe(Object.prototype);
  });
});
