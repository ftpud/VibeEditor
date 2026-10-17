import { useEffect, useRef, useState } from "react";
import type { FileRevision, LanguageExtra } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { languageClient } from "./language-client";

/** A revision-safe fallback for language plugins without a bundled form. */
export function GenericProjectConfigurationDialog({ client, language = "", running, onClose, onSaved }: { client: CoreClient; language?: string; running: boolean; onClose(): void; onSaved(options: LanguageExtra): void }) {
  const mounted = useRef(true);
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState<FileRevision>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true; mounted.current = true;
    void languageClient(client, language).request("language.configuration.read", {}).then((value) => { if (current) { setContent(value.content || value.template || ""); setRevision(value.revision); setPath(value.path); } }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; mounted.current = false; };
  }, [client, language]);
  return <div className="dialog-overlay" onMouseDown={() => { if (!saving) onClose(); }}><section className="run-config-dialog npm-config-dialog" role="dialog" aria-label="Project run configuration" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Project run configuration</h2><span>{path}</span></div><button disabled={saving} onClick={onClose}>Close</button></header><form onSubmit={(event) => {
    event.preventDefault(); if (running || loading || saving) return;
    setSaving(true); setError("");
    void languageClient(client, language).request("language.configuration.save", { content, expectedRevision: revision }).then((result) => { if (mounted.current) onSaved(result.options ?? {}); }).catch((cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (mounted.current) setSaving(false); });
  }}><div className="npm-config-body"><label>Configuration<textarea spellCheck={false} value={content} disabled={loading || saving || running} onChange={(event) => setContent(event.target.value)} /></label>{error && <p role="alert" className="run-configuration-error">{error}</p>}</div><footer><span /><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button disabled={loading || saving || running}>Save configuration</button></footer></form></section></div>;
}
