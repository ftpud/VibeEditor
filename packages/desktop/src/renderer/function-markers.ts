import type { editor } from "monaco-editor";

export interface FunctionStart { line: number; name: string }

interface NavigationTree {
  text: string;
  kind: string;
  spans?: { start: number; length: number }[];
  nameSpan?: { start: number; length: number };
  childItems?: NavigationTree[];
}

export function navigationFunctionStarts(tree: NavigationTree | undefined, model: { getPositionAt(offset: number): { lineNumber: number } }): FunctionStart[] {
  const starts: FunctionStart[] = [];
  const visit = (item: NavigationTree) => {
    if (["function", "method", "constructor", "getter", "setter"].includes(item.kind)) {
      const offset = item.nameSpan?.start ?? item.spans?.[0]?.start;
      if (offset !== undefined) starts.push({ line: model.getPositionAt(offset).lineNumber, name: item.text });
    }
    item.childItems?.forEach(visit);
  };
  if (tree) visit(tree);
  return starts;
}

export function functionStartDecorations(starts: FunctionStart[]): editor.IModelDeltaDecoration[] {
  const lines = new Set<number>();
  return starts.flatMap(({ line, name }) => {
    if (lines.has(line)) return [];
    lines.add(line);
    return [{
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: {
        glyphMarginClassName: "function-start-marker",
        glyphMargin: { position: 3 }, // Right lane; breakpoints use the center lane.
        glyphMarginHoverMessage: { value: `Method / function declaration: ${name}`, supportHtml: false, isTrusted: false }
      }
    }];
  });
}
