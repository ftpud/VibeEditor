import { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useMemo, useState } from "react";
import { configureMonacoThemes, monacoTheme } from "./theme";
import { commitResultStates, type CommitResultPreview } from "./commit-result-preview";

type Props = { path: string; preview: CommitResultPreview; result: string; selected: number; busy: boolean; onChange(value: string): void; onEditor(instance: editor.IStandaloneCodeEditor): void };
export function CommitResultEditor({ path, preview, result, selected, busy, onChange, onEditor }: Props) {
  const [instance, setInstance] = useState<editor.IStandaloneDiffEditor>();
  const states = useMemo(() => commitResultStates(preview, result), [preview, result]);
  useEffect(() => {
    if (!instance) return;
    const modified = instance.getModifiedEditor();
    const subscription = modified.onDidChangeModelContent(() => onChange(modified.getValue()));
    return () => subscription.dispose();
  }, [instance, onChange]);
  useEffect(() => {
    if (!instance) return;
    const collections = (["original", "modified"] as const).map((side) => {
      const target = side === "original" ? instance.getOriginalEditor() : instance.getModifiedEditor();
      const lastLine = target.getModel()?.getLineCount() ?? 1;
      return target.createDecorationsCollection(preview.blocks.map((block, index) => {
        const state = states[index]!;
        const line = Math.min(lastLine, side === "original" ? block.oursLine : (state.range?.start ?? block.start) + 1);
        const length = side === "original" ? (block.ours.match(/\n/g)?.length ?? 0) : state.range ? state.range.end - state.range.start : 1;
        const status = state.conflict ? "conflict" : "clean";
        return { range: { startLineNumber: line, startColumn: 1, endLineNumber: Math.min(lastLine, line + Math.max(0, length - 1)), endColumn: 1 }, options: { isWholeLine: true, className: `commit-result-${status}${selected === index ? " commit-result-selected" : ""}`, linesDecorationsClassName: `commit-result-gutter-${status}`, overviewRuler: { color: state.conflict ? "#ef6666" : "#569dff", position: 7 }, hoverMessage: { value: `Block ${index + 1}: ${state.conflict ? "conflict — resolve or choose a version" : "clean change"}` } } };
      }));
    });
    return () => collections.forEach((collection) => collection.clear());
  }, [instance, preview, states, selected]);
  useEffect(() => {
    if (!instance || selected < 0) return;
    const block = preview.blocks[selected];
    if (!block) return;
    const range = commitResultStates(preview, instance.getModifiedEditor().getValue())[selected]?.range;
    const modified = instance.getModifiedEditor();
    const line = Math.min(modified.getModel()?.getLineCount() ?? 1, (range?.start ?? block.start) + 1);
    modified.revealLineInCenter(line); modified.setPosition({ lineNumber: line, column: 1 });
    instance.getOriginalEditor().revealLineInCenter(block.oursLine);
  }, [instance, preview, selected]);
  const language = ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds", sh: "shell", yaml: "yaml", yml: "yaml", sql: "sql", rs: "rust", go: "go", cpp: "cpp" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
  return <div className="commit-result-code"><DiffEditor original={preview.local} modified={result} language={language} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(value) => { setInstance(value); onEditor(value.getModifiedEditor()); }} options={{ automaticLayout: true, readOnly: busy, originalEditable: false, renderSideBySide: false, renderIndicators: true, minimap: { enabled: false }, fontSize: 13, lineNumbersMinChars: 4, scrollBeyondLastLine: false, padding: { top: 10 }, ariaLabel: `Result for ${path}`, diffWordWrap: "off" }} /></div>;
}
