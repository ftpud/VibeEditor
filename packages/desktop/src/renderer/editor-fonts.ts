import type { Monaco } from "@monaco-editor/react";

const installed = new WeakSet<object>();

/** Web fonts can finish loading after Monaco has cached fallback character widths. */
export function installEditorFontMeasurements(monaco: Monaco, fonts = document.fonts): void {
  if (!fonts || installed.has(monaco.editor)) return;
  installed.add(monaco.editor);
  const remeasure = () => monaco.editor.remeasureFonts();
  fonts.addEventListener("loadingdone", remeasure);
  void Promise.all([
    fonts.load('normal 13px "JetBrains Mono"'),
    fonts.load('bold 13px "JetBrains Mono"'),
    fonts.load('italic 13px "JetBrains Mono"'),
    fonts.load('bold italic 13px "JetBrains Mono"')
  ]).then(remeasure).catch(() => { /* Later successful font loads still trigger remeasurement. */ });
}
