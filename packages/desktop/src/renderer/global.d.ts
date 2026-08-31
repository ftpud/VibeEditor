interface Window {
  desktop?: {
    setDirtyState(dirty: boolean): void;
    openEditorWindow(options: { host: string; port: string; type: "file" | "useful"; path: string; scope?: "global" | "local" }): void;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    chooseUpload(): Promise<{ id: string; name: string; size: number } | undefined>;
    chooseDownload(name: string): Promise<{ id: string; name: string } | undefined>;
    startProjectTransfer(options: { localId: string; token: string; host: string; port: number; direction: "upload" | "download"; size: number }): Promise<{ operationId: string }>;
    cancelProjectTransfer(operationId: string): Promise<boolean>;
    onProjectTransferProgress(listener: (progress: { operationId: string; bytes: number; total: number; done?: boolean; error?: string }) => void): () => void;
    loadSettings?(): Record<string, string>;
    writeSetting?(key: string, value: string | null): void;
  };
}
