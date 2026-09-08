import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { configureMonacoThemes, monacoTheme } from "./theme";
import { applyBlock, lines, mergeBlocks, mergeNonConflicting, resultRange } from "./conflict-merge";

type Props = { path: string; base: string; ours?: string; theirs?: string; result: string; language: string; busy: boolean; onChange(value: string): void };
export function ConflictCompareEditor({ path, base, ours, theirs, result, language, busy, onChange }: Props) {
  const [instances, setInstances] = useState<Partial<Record<"ours" | "theirs" | "result", editor.IStandaloneCodeEditor>>>({});
  const [notice, setNotice] = useState("");
  const syncing = useRef(false);
  const comparison = useMemo(() => {
    try { return { blocks: mergeBlocks(base, ours ?? "", theirs ?? ""), error: "" }; }
    catch (reason) { return { blocks: [], error: String(reason) }; }
  }, [base, ours, theirs]);
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
          try { const range = resultRange(base, result, block); if (!range) return; line = range.start + 1; length = range.end - range.start; } catch { return; }
        } else { line = block[side === "ours" ? "oursLine" : "theirsLine"]; length = lines(block[side]).length; }
        const lastLine = instance.getModel()?.getLineCount() ?? 1;
        line = Math.min(line, lastLine);
        decorations.push({ range: { startLineNumber: line, startColumn: 1, endLineNumber: Math.min(lastLine, line + Math.max(0, length - 1)), endColumn: 1 }, options: { isWholeLine: true, className: block.conflict ? "merge-block-conflict" : "merge-block-safe", linesDecorationsClassName: block.conflict ? "merge-line-conflict" : "merge-line-safe" } });
        if (side === "result" || (side === "ours" ? ours : theirs) === undefined) return;
        const button = document.createElement("button");
        button.className = "merge-block-button";
        button.textContent = "→";
        button.title = `Apply ${side} block ${index + 1} to result${length === 0 ? " (delete block)" : ""}`;
        button.setAttribute("aria-label", button.title);
        button.disabled = busy;
        const accept = () => run(() => applyBlock(base, result, block, side));
        button.addEventListener("click", accept);
        const widget: editor.IGlyphMarginWidget = { getId: () => `merge-${side}-${index}`, getDomNode: () => button, getPosition: () => ({ lane: 2, zIndex: 10, range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 } }) };
        instance.addGlyphMarginWidget(widget);
        cleanups.push(() => { instance.removeGlyphMarginWidget(widget); button.removeEventListener("click", accept); });
      });
      const collection = instance.createDecorationsCollection(decorations);
      cleanups.push(() => collection.clear());
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [instances, comparison, base, result, busy, ours, theirs, onChange]);
  return <>
    <div className="conflict-toolbar"><strong title={path}>{path}</strong><span>{comparison.blocks.filter((block) => block.conflict).length} conflicting blocks</span><button disabled={busy || Boolean(comparison.error)} onClick={() => run(() => mergeNonConflicting(base, result, comparison.blocks))}>Merge non-conflicting changes</button></div>
    <div className="conflict-three-panes">{(["ours", "theirs", "result"] as const).map((side) => <section key={side} className={`conflict-code-pane conflict-code-${side}`} aria-label={`${side} pane`}>
      <header><strong>{side === "result" ? "Resolution result" : side === "ours" ? "Ours" : "Theirs"}</strong>{side === "result" ? <small>Editable · review before staging</small> : <button disabled={busy || (side === "ours" ? ours : theirs) === undefined} onClick={() => onChange((side === "ours" ? ours : theirs) ?? "")}>Use {side}</button>}</header>
      {side !== "result" && (side === "ours" ? ours : theirs) === undefined && <small className="conflict-missing">Not present · deleted in this version</small>}
      <div className="conflict-code-editor"><Editor value={side === "result" ? result : (side === "ours" ? ours : theirs) ?? ""} language={language} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(instance) => setInstances((previous) => ({ ...previous, [side]: instance }))} onChange={side === "result" ? (value) => onChange(value ?? "") : undefined} options={{ ariaLabel: `${side === "result" ? "Resolution result" : side} for ${path}`, automaticLayout: true, readOnly: side !== "result" || busy, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, glyphMargin: side !== "result", lineDecorationsWidth: 8, scrollBeyondLastLine: false, wordWrap: "off", padding: { top: 8 } }} /></div>
    </section>)}</div>
    <div className="conflict-merge-status" role="status">{comparison.error || notice || "Use the arrows beside highlighted blocks to apply either version. Amber blocks need a decision; green blocks can merge automatically."}</div>
  </>;
}
