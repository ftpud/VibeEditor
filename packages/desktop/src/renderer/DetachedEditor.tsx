import Editor from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CoreClient } from "./client";
import { configureMonacoThemes, monacoTheme } from "./theme";

const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", html: "html", css: "css", md: "markdown", java: "java", py: "python", yaml: "yaml", yml: "yaml", http: "http", txt: "plaintext" };

export function DetachedEditor() {
  const options = useRef(new URLSearchParams(window.location.search)).current;
  const path = options.get("path") ?? ""; const type = options.get("type"); const scope = options.get("scope") as "global" | "local" | null;
  const [content, setContent] = useState(""); const [saved, setSaved] = useState(""); const [error, setError] = useState(""); const [ready, setReady] = useState(false);
  const clientRef = useRef<CoreClient>(); const dirty = content !== saved;
  useEffect(() => { document.title = path.split("/").pop() ?? path; }, [path]);
  useEffect(() => { window.desktop?.setDirtyState(dirty); }, [dirty]);
  useEffect(() => {
    if (!path || (type !== "file" && type !== "useful")) { setError("Invalid detached editor request"); return; }
    const client = new CoreClient(); clientRef.current = client; let current = true;
    void client.connect(options.get("host") ?? "127.0.0.1", Number(options.get("port") ?? "7331")).then(async () => {
      await client.request("workspace.open", {});
      const tasks = await client.request("tasks.list", {}); await client.request("tasks.switch", { ...(tasks.selectedTaskId ? { taskId: tasks.selectedTaskId } : {}) });
      const result = type === "useful" ? await client.request("useful.read", { scope: scope!, name: path }) : await client.request("filesystem.readFile", { path });
      if (current) { setContent(result.content); setSaved(result.content); setReady(true); }
    }).catch((loadError: unknown) => { if (current) setError(loadError instanceof Error ? loadError.message : "Could not open editor"); });
    return () => { current = false; client.disconnect(); };
  }, [options, path, scope, type]);
  useEffect(() => {
    if (!ready || !dirty || !clientRef.current) return;
    const value = content; const timer = setTimeout(() => {
      const request = type === "useful" ? clientRef.current!.request("useful.write", { scope: scope!, name: path, content: value }) : clientRef.current!.request("filesystem.writeFile", { path, content: value });
      void request.then(() => setSaved((current) => current === content ? current : value)).catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "Autosave failed"));
    }, 600);
    return () => clearTimeout(timer);
  }, [content, dirty, path, ready, scope, type]);
  if (error && !ready) return <main className="detached-error">{error}</main>;
  return <main className="detached-editor">{error && <div className="inline-error">{error}</div>}{ready ? <Editor path={`detached/${type}/${scope ?? "workspace"}/${path}`} language={languages[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} value={content} beforeMount={configureMonacoThemes} theme={monacoTheme()} options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, padding: { top: 10 } }} onChange={(value) => { setContent(value ?? ""); setError(""); }} /> : <div className="empty-editor">Opening {path}...</div>}</main>;
}
