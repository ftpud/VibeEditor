import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { editor } from "monaco-editor";

export type EditorStatusState = { line: number; column: number; selectedCharacters: number; language: string; indentation: string };
export type EditorStatusBarHandle = { attach(instance: editor.IStandaloneCodeEditor): void };

const languageNames: Record<string, string> = { css: "CSS", html: "HTML", http: "HTTP", javascript: "JavaScript", json: "JSON", markdown: "Markdown", plaintext: "Plain Text", python: "Python", shell: "Shell", typescript: "TypeScript", xml: "XML", yaml: "YAML" };

export function formatLanguage(language: string): string {
  return languageNames[language] ?? language.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatIndentation(insertSpaces: boolean, tabSize: number): string {
  return insertSpaces ? `Spaces: ${tabSize}` : `Tab Size: ${tabSize}`;
}

export function sameEditorStatus(left: EditorStatusState | undefined, right: EditorStatusState | undefined): boolean {
  return left === right || Boolean(left && right && left.line === right.line && left.column === right.column && left.selectedCharacters === right.selectedCharacters && left.language === right.language && left.indentation === right.indentation);
}

function readStatus(instance: editor.IStandaloneCodeEditor): EditorStatusState | undefined {
  const model = instance.getModel(); const position = instance.getPosition();
  if (!model || !position) return undefined;
  const selection = instance.getSelection(); const options = model.getOptions();
  return { line: position.lineNumber, column: position.column, selectedCharacters: selection && !selection.isEmpty() ? model.getValueLengthInRange(selection) : 0, language: formatLanguage(model.getLanguageId()), indentation: formatIndentation(options.insertSpaces, options.tabSize) };
}

export const EditorStatusBar = forwardRef<EditorStatusBarHandle, { active: boolean }>(function EditorStatusBar({ active }, ref) {
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const disposablesRef = useRef<{ dispose(): void }[]>([]);
  const [status, setStatus] = useState<EditorStatusState>();
  const detach = () => { for (const disposable of disposablesRef.current) disposable.dispose(); disposablesRef.current = []; editorRef.current = undefined; };

  useImperativeHandle(ref, () => ({ attach(instance) {
    detach(); editorRef.current = instance;
    const update = () => { const next = readStatus(instance); setStatus((current) => sameEditorStatus(current, next) ? current : next); };
    disposablesRef.current = [instance.onDidChangeCursorPosition(update), instance.onDidChangeCursorSelection(update), instance.onDidChangeModel(update), instance.onDidChangeModelLanguage(update), instance.onDidChangeConfiguration(update), instance.onDidChangeModelContent(update)];
    update();
  } }));
  useEffect(() => { if (!active) { detach(); setStatus(undefined); } }, [active]);
  useEffect(() => () => detach(), []);

  if (!active || !status) return null;
  return <footer className="editor-status-bar" aria-label="Editor status"><button type="button" title="Go to Line (Ctrl+G)" onClick={() => editorRef.current?.trigger("editor-status-bar", "editor.action.gotoLine", null)}>Ln {status.line}, Col {status.column}</button>{status.selectedCharacters > 0 && <span>{status.selectedCharacters.toLocaleString()} selected</span>}<span>{status.language}</span><span>{status.indentation}</span></footer>;
});
