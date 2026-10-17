import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** Follow live text, but let readers scroll back. Reopening a hidden preview starts at the latest message. */
export function useWorkflowTranscript(ref: RefObject<HTMLDivElement>, scope: string, revision: string) {
  const following = useRef(true);
  const wasVisible = useRef(false);
  const followLatest = useCallback(() => {
    following.current = true;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [ref]);
  useLayoutEffect(() => { wasVisible.current = false; following.current = true; }, [scope]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    const adjust = () => {
      if (disposed) return;
      const visible = element.clientHeight > 0;
      if (visible && !wasVisible.current) following.current = true;
      wasVisible.current = visible;
      if (visible && following.current) element.scrollTop = element.scrollHeight;
    };
    adjust();
    const frame = requestAnimationFrame(adjust);
    // The container changes size after opening/expanding a workflow preview;
    // the last message can resize later as Markdown content finishes laying out.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(adjust);
    observer?.observe(element);
    if (element.lastElementChild) observer?.observe(element.lastElementChild);
    return () => { disposed = true; cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [ref, scope, revision]);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element && element.clientHeight > 0) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  }, [ref]);
  return { onScroll, followLatest };
}

/** Stable writer colors for shared Meeting transcripts, independent of provider IDs. */
export function workflowWriterColor(writer: string): string {
  const colors = ["#6366f1", "#0d9488", "#d97706", "#db2777", "#0284c7", "#9333ea"];
  let hash = 0;
  for (const character of writer) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}
