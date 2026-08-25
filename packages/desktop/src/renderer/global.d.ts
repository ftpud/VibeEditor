interface Window {
  desktop?: {
    setDirtyState(dirty: boolean): void;
    openEditorWindow(options: { host: string; port: string; type: "file" | "useful"; path: string; scope?: "global" | "local" }): void;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
}
