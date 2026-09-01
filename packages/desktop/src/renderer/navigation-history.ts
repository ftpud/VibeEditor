export type EditorLocation = { rootId: string; path: string; line: number; column: number };

export class NavigationHistory {
  private entries: EditorLocation[] = [];
  private index = -1;
  constructor(private readonly limit = 100) {}
  visit(location: EditorLocation): void {
    const current = this.entries[this.index];
    if (current && current.rootId === location.rootId && current.path === location.path && current.line === location.line && current.column === location.column) return;
    this.entries = [...this.entries.slice(0, this.index + 1), location].slice(-this.limit); this.index = this.entries.length - 1;
  }
  back(): EditorLocation | undefined { if (this.index <= 0) return undefined; this.index -= 1; return this.entries[this.index]; }
  forward(): EditorLocation | undefined { if (this.index >= this.entries.length - 1) return undefined; this.index += 1; return this.entries[this.index]; }
  clear(): void { this.entries = []; this.index = -1; }
}
