import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkflowTranscript, workflowWriterColor } from "./workflow-transcript";

let contentHeight = 1200;
let viewportHeight = 300;
let observers: TestObserver[];
class TestObserver {
  disconnected = false;
  constructor(private readonly callback: () => void) { observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
  notify() { this.callback(); }
}
function Transcript({ revision = "initial", scope = "conversation" }: { revision?: string; scope?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let top = 0;
    Object.defineProperties(ref.current!, {
      scrollHeight: { configurable: true, get: () => contentHeight },
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, contentHeight - viewportHeight)); } }
    });
  }, []);
  const { onScroll } = useWorkflowTranscript(ref, scope, revision);
  return <div role="log" ref={ref} onScroll={onScroll}><p>{revision}</p></div>;
}
beforeEach(() => { contentHeight = 1200; viewportHeight = 300; observers = []; vi.stubGlobal("ResizeObserver", TestObserver); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("opens a conversation at its latest message and follows streaming text", () => {
  const view = render(<Transcript />);
  expect(screen.getByRole("log").scrollTop).toBe(900);
  contentHeight = 1500;
  view.rerender(<Transcript revision="streamed text" />);
  expect(screen.getByRole("log").scrollTop).toBe(1200);
});
it("preserves a reader's scroll position until they return to the bottom", () => {
  const view = render(<Transcript />);
  const transcript = screen.getByRole("log");
  transcript.scrollTop = 100; fireEvent.scroll(transcript);
  contentHeight = 1500;
  view.rerender(<Transcript revision="new message" />);
  expect(transcript.scrollTop).toBe(100);
  transcript.scrollTop = 1200; fireEvent.scroll(transcript);
  contentHeight = 1600;
  view.rerender(<Transcript revision="more text" />);
  expect(transcript.scrollTop).toBe(1300);
});
it("scrolls after a hidden preview becomes visible, including reopening after reading history", () => {
  viewportHeight = 0;
  render(<Transcript />);
  const transcript = screen.getByRole("log");
  viewportHeight = 300;
  act(() => observers.at(-1)!.notify());
  expect(transcript.scrollTop).toBe(900);
  transcript.scrollTop = 100; fireEvent.scroll(transcript);
  viewportHeight = 0; act(() => observers.at(-1)!.notify());
  viewportHeight = 300; act(() => observers.at(-1)!.notify());
  expect(transcript.scrollTop).toBe(900);
});
it("does not let an old resize callback move a closed preview", () => {
  const view = render(<Transcript />);
  const transcript = screen.getByRole("log");
  const observer = observers.at(-1)!;
  view.unmount(); transcript.scrollTop = 100;
  act(() => observer.notify());
  expect(observer.disconnected).toBe(true);
  expect(transcript.scrollTop).toBe(100);
});
it("keeps writer colors stable and distinguishes meeting authors", () => {
  expect(workflowWriterColor("CODEX")).toBe(workflowWriterColor("CODEX"));
  expect(workflowWriterColor("CLAUDE")).not.toBe(workflowWriterColor("CODEX"));
});
