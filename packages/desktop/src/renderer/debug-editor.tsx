import type { Monaco } from "@monaco-editor/react";
import type { editor, IPosition } from "monaco-editor";
import { createRoot } from "react-dom/client";
import type { JavaDebugState, JavaDebugVariable } from "@remote-ide/protocol";
import { DebugVariable, type DebugInspect } from "./DebugVariable";

/** Only read identifiers, fields, and array elements; never execute hovered code. */
export function debugHoverExpression(line: string, column: number): string | undefined {
  const end = column - 1 + (line.slice(column - 1).match(/^[\w$]*/)?.[0].length ?? 0);
  return line.slice(0, end).match(/(?:\b[A-Za-z_$][\w$]*)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[\d+\]))*$/)?.[0];
}

export async function resolveDebugHover(expression: string, state: JavaDebugState, inspect: DebugInspect): Promise<JavaDebugVariable | undefined> {
  if (state.status !== "paused" || state.applyingChanges) return;
  const parts = expression.match(/[A-Za-z_$][\w$]*|\[\d+\]/g) ?? [];
  if (!parts.length || parts.length > 12) return;
  let variable = state.variables.find((item) => item.name === parts[0]);
  if (!variable) {
    const self = state.variables.find((item) => item.name === "this");
    if (!self?.reference) return;
    const fields = await inspect(self.reference);
    variable = fields.variables.find((item) => item.name === parts[0] || item.name.endsWith(`.${parts[0]}`));
  }
  for (const part of parts.slice(1)) {
    if (!variable?.reference) return;
    const index = part.startsWith("[") ? Number(part.slice(1, -1)) : undefined;
    const fields = await inspect(variable.reference, index);
    variable = fields.variables.find((item) => item.name === part || item.name.endsWith(`.${part}`));
  }
  return variable ? { ...variable, name: expression } : undefined;
}

export function attachDebugEditor(instance: editor.IStandaloneCodeEditor, api: Monaco, filePath: string, inspect: DebugInspect) {
  const decorations = instance.createDecorationsCollection();
  const node = document.createElement("div");
  node.className = "debug-editor-hover";
  node.setAttribute("role", "tooltip");
  const root = createRoot(node);
  let position: IPosition | null = null;
  const widget: editor.IContentWidget = {
    getId: () => "vibe.debug.object-hover",
    getDomNode: () => node,
    allowEditorOverflow: true,
    suppressMouseDown: true,
    getPosition: () => position ? { position, preference: [api.editor.ContentWidgetPositionPreference.BELOW, api.editor.ContentWidgetPositionPreference.ABOVE] } : null
  };
  instance.addContentWidget(widget);
  let state: JavaDebugState = { status: "stopped", variables: [] };
  let expression: string | undefined;
  let generation = 0;
  let disposed = false;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    generation++; expression = undefined; position = null;
    clearTimeout(hoverTimer); clearTimeout(hideTimer);
    root.render(null); if (!disposed) instance.layoutContentWidget(widget);
  };
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 250); };
  node.onmouseenter = () => clearTimeout(hideTimer);
  node.onmouseleave = scheduleHide;
  const move = instance.onMouseMove((event) => {
    if ((event.target.element as HTMLElement | null)?.closest(".debug-editor-hover")) { clearTimeout(hideTimer); return; }
    const model = instance.getModel();
    const hovered = event.target.position;
    if (state.status !== "paused" || state.applyingChanges || state.path !== filePath || !model || !hovered || !model.getWordAtPosition(hovered)) { scheduleHide(); return; }
    const next = debugHoverExpression(model.getLineContent(hovered.lineNumber), hovered.column);
    if (!next) { scheduleHide(); return; }
    clearTimeout(hideTimer);
    if (expression === next) return;
    hide(); expression = next;
    const request = generation;
    const pause = state;
    hoverTimer = setTimeout(() => {
      void resolveDebugHover(next, pause, inspect).then((variable) => {
        if (request !== generation || !variable) return;
        position = hovered;
        root.render(<><header>Paused value{variable.type ? ` · ${variable.type}` : ""}</header><div className="debug-hover-tree"><DebugVariable key={`${request}:${variable.reference ?? next}`} variable={variable} onInspect={inspect} initialExpanded /></div></>);
        instance.layoutContentWidget(widget);
      }).catch(() => { if (request === generation) hide(); });
    }, 350);
  });
  const leave = instance.onMouseLeave(scheduleHide);
  const edit = instance.onDidChangeModelContent(hide);
  const controller = {
    update(next: JavaDebugState) {
      if (disposed) return;
      state = next; hide();
      const line = next.status === "paused" && next.path === filePath ? next.line : undefined;
      decorations.set(line ? [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "debug-current-line", linesDecorationsClassName: "debug-current-line-marker", overviewRuler: { color: "#e4bd55", position: api.editor.OverviewRulerLane.Full } } }] : []);
      if (line) instance.revealLineInCenterIfOutsideViewport(line);
    },
    dispose() {
      if (disposed) return;
      disposed = true; hide(); move.dispose(); leave.dispose(); edit.dispose(); decorations.clear(); instance.removeContentWidget(widget); root.unmount(); disposeListener.dispose();
    }
  };
  const disposeListener = instance.onDidDispose(() => controller.dispose());
  return controller;
}
