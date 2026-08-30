/** Monaco view state is intentionally kept per open tab, not per path. */
export type ViewStateEditor = { saveViewState(): unknown | null; restoreViewState(state: unknown): void };

export class EditorViewStateStore {
  private readonly states = new Map<string, unknown>();
  private mountedTabId: string | undefined;

  capture(editor: ViewStateEditor | undefined): void {
    if (!editor || !this.mountedTabId) return;
    const state = editor.saveViewState();
    if (state) this.states.set(this.mountedTabId, state);
  }

  mount(tabId: string, editor: ViewStateEditor): boolean {
    this.mountedTabId = tabId;
    const state = this.states.get(tabId);
    if (!state) return false;
    editor.restoreViewState(state);
    return true;
  }

  clearMounted(): void { this.mountedTabId = undefined; }
  remove(tabId: string): void { this.states.delete(tabId); }
}
