import { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useState } from "react";
import type { CommitResultPreview } from "./commit-result-preview";
import { configureMonacoThemes, monacoTheme } from "./theme";

type Props = { path: string; preview: CommitResultPreview; selected: number };

export function languageForPath(path: string): string {
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds", sh: "shell", yaml: "yaml", yml: "yaml", sql: "sql", rs: "rust", go: "go", cpp: "cpp" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

export function CommitBlockDiff({ path, preview, selected }: Props) {
  const [instance, setInstance] = useState<editor.IStandaloneDiffEditor>();
  useEffect(() => {
    const block = preview.blocks[selected];
    if (!instance || !block) return;
    instance.getOriginalEditor().revealLineInCenter(Math.max(1, block.start + 1));
    instance.getModifiedEditor().revealLineInCenter(Math.max(1, block.theirsLine));
  }, [instance, preview, selected]);
  return <div className="commit-block-diff" aria-label={`Source change for block ${selected + 1}`}>
    <DiffEditor original={preview.base} modified={preview.incoming} language={languageForPath(path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={setInstance} options={{ automaticLayout: true, readOnly: true, renderSideBySide: false, renderIndicators: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 8 }, diffWordWrap: "off", hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 5 } }} />
  </div>;
}
