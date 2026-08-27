import type { EditorTab } from "./model";

export type CursorPosition = { lineNumber: number; column: number };
type CursorDocument = Pick<EditorTab, "type" | "path" | "diffRef" | "diffPath" | "usefulScope" | "agentScope">;
type CursorModel = { getLineCount(): number; getLineMaxColumn(lineNumber: number): number };
type CursorPersistence = { read(workspace: string): string | null; write(workspace: string, value: string): void };

export const CURSOR_POSITIONS_SETTING = "editor.cursorPositions";

/** A document identity that survives tab closure and the random tab IDs assigned on reopen. */
export function cursorDocumentIdentity(document: CursorDocument): string {
  const scope = document.type === "useful" ? document.usefulScope ?? "global"
    : document.type === "agent" ? document.agentScope ?? "global"
      : document.type === "diff" ? `${document.diffRef ?? "working"}:${document.diffPath ?? document.path}`
        : "workspace";
  return JSON.stringify([document.type, scope, document.path]);
}

export function validateCursorPosition(position: CursorPosition | undefined, model: CursorModel): CursorPosition | undefined {
  if (!position || !Number.isInteger(position.lineNumber) || !Number.isInteger(position.column) || position.lineNumber < 1 || position.column < 1) return undefined;
  const lineCount = model.getLineCount();
  if (!Number.isInteger(lineCount) || lineCount < 1) return undefined;
  const lineNumber = Math.min(position.lineNumber, lineCount);
  const maxColumn = model.getLineMaxColumn(lineNumber);
  if (!Number.isInteger(maxColumn) || maxColumn < 1) return undefined;
  return { lineNumber, column: Math.min(position.column, maxColumn) };
}

function parsePositions(value: string | null): Record<string, CursorPosition> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const positions: Record<string, CursorPosition> = {};
    for (const [key, position] of Object.entries(parsed as Record<string, unknown>)) {
      if (!position || typeof position !== "object" || Array.isArray(position)) continue;
      const { lineNumber, column } = position as Record<string, unknown>;
      if (Number.isInteger(lineNumber) && Number.isInteger(column) && (lineNumber as number) > 0 && (column as number) > 0) positions[key] = { lineNumber: lineNumber as number, column: column as number };
    }
    return positions;
  } catch { return {}; }
}

/** Keeps tab switches synchronous in memory while batching durable settings writes. */
export class CursorPositionStore {
  private workspace = "";
  private positions: Record<string, CursorPosition> = {};
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly persistence: CursorPersistence, private readonly debounceMs = 500) {}

  setWorkspace(workspace: string): void {
    if (workspace === this.workspace) return;
    this.flush();
    this.workspace = workspace;
    this.positions = workspace ? parsePositions(this.persistence.read(workspace)) : {};
  }

  get(document: CursorDocument): CursorPosition | undefined {
    return this.positions[cursorDocumentIdentity(document)];
  }

  update(document: CursorDocument, position: CursorPosition): void {
    if (!this.workspace || !Number.isInteger(position.lineNumber) || !Number.isInteger(position.column) || position.lineNumber < 1 || position.column < 1) return;
    const key = cursorDocumentIdentity(document);
    const previous = this.positions[key];
    if (previous?.lineNumber === position.lineNumber && previous.column === position.column) return;
    this.positions[key] = position;
    this.dirty = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined; }
    if (!this.workspace || !this.dirty) return;
    this.persistence.write(this.workspace, JSON.stringify(this.positions));
    this.dirty = false;
  }

  dispose(): void { this.flush(); }
}
