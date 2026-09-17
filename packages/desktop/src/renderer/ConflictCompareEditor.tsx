import Editor from "@monaco-editor/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { configureMonacoThemes, monacoTheme } from "./theme";
import { applyBlock, blockStates, lines, mergeBlocks, mergeNonConflicting } from "./conflict-merge";

type Props = { path: string; base: string; ours?: string; theirs?: string; result: string; language: string; busy: boolean; reviewed?: Record<number, string>; onReview?(index: number, text: string): void; onChange(value: string): void };
export function ConflictCompareEditor({ path, base, ours, theirs, result, language, busy, reviewed: savedReviews, onReview, onChange }: Props) {
  const [instances, setInstances] = useState<Partial<Record<"ours" | "theirs" | "result", editor.IStandaloneCodeEditor>>>({});
  const [notice, setNotice] = useState("");
  const syncing = useRef(false);
  const [selected, setSelected] = useState<number>();
  const [localReviews, setReviewed] = useState<Record<number, string>>({});
  const reviewed = savedReviews ?? localReviews;
  const [widths, setWidths] = useState([30, 40, 30]);
  const drag = useRef<{ index: number; x: number; width: number; values: number[] }>();

  const comparison = useMemo(() => {
    try { return { blocks: mergeBlocks(base, ours ?? "", theirs ?? ""), error: "" }; }
    catch (reason) { return { blocks: [], error: String(reason) }; }
  }, [base, ours, theirs]);
  const progress = useMemo(() => {
    try { return { states: blockStates(base, result, comparison.blocks), error: "" }; }
    catch (reason) { return { states: comparison.blocks.map(() => ({ status: "review" as const, range: undefined, text: undefined })), error: String(reason) }; }
  }, [base, result, comparison]);
  const states = progress.states.map((state, index) => state.status === "review" && state.text !== undefined && reviewed[index] === state.text ? { ...state, status: "merged" as const } : state);
  const remaining = states.flatMap((state, index) => state.status === "conflict" || state.status === "review" ? [index] : []);
  const conflicts = states.filter((state) => state.status === "conflict").length;
  const pending = states.filter((state) => state.status === "pending").length;
  const reviewCount = states.filter((state) => state.status === "review").length;
  const merged = states.filter((state) => state.status === "merged").length;
  const jump = (index: number) => {
    const block = comparison.blocks[index];
    if (!block) return;
    setSelected(index);
    syncing.current = true;
    for (const side of ["ours", "result", "theirs"] as const) {
      const instance = instances[side];
      const line = side === "result" ? (states[index]?.range?.start ?? block.start) + 1 : block[side === "ours" ? "oursLine" : "theirsLine"];
      instance?.revealLineInCenter(Math.min(line, instance.getModel()?.getLineCount() ?? line));
    }
    syncing.current = false;
  };
  const navigate = (direction: number) => {
    const index = direction > 0 ? remaining.find((item) => item > (selected ?? -1)) ?? remaining[0] : [...remaining].reverse().find((item) => item < (selected ?? Infinity)) ?? remaining.at(-1);
    if (index !== undefined) jump(index);
  };
  const resize = (index: number, delta: number, values = widths) => {
    const left = values[index]!, right = values[index + 1]!;
    const change = Math.max(15 - left, Math.min(right - 15, delta));
    setWidths(values.map((value, item) => item === index ? value + change : item === index + 1 ? value - change : value));
  };
  const run = (action: () => string) => {
    try { const next = action(); onChange(next); setNotice(next === result ? "No pending non-conflicting changes. Existing result edits are preserved." : "Changes applied to the result. Review before staging."); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    const subscriptions = Object.values(instances).map((instance) => instance.onDidScrollChange((event) => {
      if (syncing.current || !event.scrollTopChanged) return;
      syncing.current = true;
      const fraction = event.scrollTop / Math.max(1, instance.getScrollHeight() - instance.getLayoutInfo().height);
      for (const other of Object.values(instances)) if (other !== instance) other.setScrollTop(fraction * Math.max(0, other.getScrollHeight() - other.getLayoutInfo().height));
      syncing.current = false;
    }));
    return () => subscriptions.forEach((subscription) => subscription.dispose());
  }, [instances]);
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const side of ["ours", "theirs", "result"] as const) {
      const instance = instances[side];
      if (!instance) continue;
      const decorations: editor.IModelDeltaDecoration[] = [];
      comparison.blocks.forEach((block, index) => {
        let line: number, length: number;
        if (side === "result") {
          const range = states[index]?.range; line = (range?.start ?? block.start) + 1; length = range ? range.end - range.start : 1;
        } else { line = block[side === "ours" ? "oursLine" : "theirsLine"]; length = lines(block[side]).length; }
        const lastLine = instance.getModel()?.getLineCount() ?? 1;
        line = Math.min(line, lastLine);
        const status = states[index]?.status ?? "review";
        decorations.push({ range: { startLineNumber: line, startColumn: 1, endLineNumber: Math.min(lastLine, line + Math.max(0, length - 1)), endColumn: 1 }, options: { isWholeLine: true, className: `merge-block-${status}${selected === index ? " merge-block-selected" : ""}`, linesDecorationsClassName: `merge-line-${status}` } });
        if (side === "result" || (side === "ours" ? ours : theirs) === undefined) return;
        const button = document.createElement("button");
        button.className = "merge-block-button";
        button.textContent = side === "ours" ? "→" : "←";
        button.title = `${status === "merged" ? "Replace with" : "Apply"} ${side} block ${index + 1} to result${length === 0 ? " (delete block)" : ""}`;
        button.setAttribute("aria-label", button.title);
        button.disabled = busy;
        button.dataset.status = status;
        const accept = () => { setSelected(index); run(() => applyBlock(base, result, block, side, comparison.blocks)); };
        button.addEventListener("click", accept);
        const widget: editor.IGlyphMarginWidget = { getId: () => `merge-${side}-${index}`, getDomNode: () => button, getPosition: () => ({ lane: 2, zIndex: 10, range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 } }) };
        instance.addGlyphMarginWidget(widget);
        cleanups.push(() => { instance.removeGlyphMarginWidget(widget); button.removeEventListener("click", accept); });
      });
      const collection = instance.createDecorationsCollection(decorations);
      cleanups.push(() => collection.clear());
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [instances, comparison, base, result, busy, ours, theirs, onChange, reviewed, selected]);
  return <>
    <div className="conflict-toolbar"><strong title={path}>{path}</strong><button disabled={busy || !pending || Boolean(comparison.error || progress.error)} onClick={() => run(() => mergeNonConflicting(base, result, comparison.blocks))}>Merge non-conflicting changes</button></div>
    <div className="conflict-progress" role="status"><strong>{conflicts} conflicts remaining</strong><span>{reviewCount} need review</span><span>{pending} ready to merge</span><span className="conflict-merged-count">{merged} merged / {states.length} blocks</span></div>
    <div className="conflict-navigation"><button disabled={!remaining.length} onClick={() => navigate(-1)}>↑ Previous conflict</button><button disabled={!remaining.length} onClick={() => navigate(1)}>↓ Next conflict</button><span>{selected !== undefined ? `Block ${selected + 1} · ${states[selected]?.status === "review" ? "needs review" : states[selected]?.status === "pending" ? "ready to merge" : states[selected]?.status}` : "Select a block or jump to the next conflict"}</span>{selected !== undefined && states[selected]?.status === "review" && states[selected]?.text !== undefined && <button disabled={busy} onClick={() => { const text = states[selected]!.text!; if (onReview) onReview(selected, text); else setReviewed((previous) => ({ ...previous, [selected]: text })); }}>Mark block reviewed</button>}</div>
    <div className="conflict-block-index" aria-label="Merge blocks">{states.map((state, index) => <button key={index} className={`conflict-block-chip ${state.status}`} aria-pressed={selected === index} onClick={() => jump(index)} title={`Jump to block ${index + 1}: ${state.status}`}>{state.status === "merged" ? "✓" : state.status === "pending" ? "+" : "!"} {index + 1} · {state.status === "review" ? "review" : state.status}</button>)}</div>
    <div className="conflict-three-panes" style={{ gridTemplateColumns: `minmax(0, ${widths[0]}fr) 6px minmax(0, ${widths[1]}fr) 6px minmax(0, ${widths[2]}fr)` }}>{(["ours", "result", "theirs"] as const).map((side, paneIndex) => <Fragment key={side}>{paneIndex > 0 && <div className="conflict-pane-resizer" role="separator" aria-label={paneIndex === 1 ? "Resize ours and result panels" : "Resize result and theirs panels"} aria-orientation="vertical" aria-valuenow={Math.round(widths[paneIndex - 1]!)} aria-valuemin={15} aria-valuemax={widths[paneIndex - 1]! + widths[paneIndex]! - 15} tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(paneIndex - 1, event.key === "ArrowLeft" ? -2 : 2); } }} onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { index: paneIndex - 1, x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width, values: widths }; }} onPointerMove={(event) => { const current = drag.current; if (current) resize(current.index, (event.clientX - current.x) / current.width * 100, current.values); }} onPointerUp={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }} /> }<section className={`conflict-code-pane conflict-code-${side}`} aria-label={`${side} pane`}>
      <header><strong>{side === "result" ? "Resolution result" : side === "ours" ? "Ours" : "Theirs"}</strong>{side === "result" ? <small>Editable · review before staging</small> : <button disabled={busy || (side === "ours" ? ours : theirs) === undefined} onClick={() => onChange((side === "ours" ? ours : theirs) ?? "")}>Use {side}</button>}</header>
      {side !== "result" && (side === "ours" ? ours : theirs) === undefined && <small className="conflict-missing">Not present · deleted in this version</small>}
      <div className="conflict-code-editor"><Editor value={side === "result" ? result : (side === "ours" ? ours : theirs) ?? ""} language={language} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(instance) => setInstances((previous) => ({ ...previous, [side]: instance }))} onChange={side === "result" ? (value) => onChange(value ?? "") : undefined} options={{ ariaLabel: `${side === "result" ? "Resolution result" : side} for ${path}`, automaticLayout: true, readOnly: side !== "result" || busy, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, glyphMargin: side !== "result", lineDecorationsWidth: 8, scrollBeyondLastLine: false, wordWrap: "off", padding: { top: 8 } }} /></div>
    </section></Fragment>)}</div>
    <div className="conflict-merge-status" role="status">{comparison.error || progress.error || notice || (remaining.length || pending ? "Amber: unresolved conflict · Purple: manual review · Blue: ready to merge · Green: merged. Use the block list to jump to any change." : "All blocks are merged or reviewed. Review the result, then mark the file resolved.")}</div>
  </>;
}
