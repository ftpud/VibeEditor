import { useEffect, useRef, useState } from "react";
import type { AiPermissionRequest, AiProvider } from "@remote-ide/protocol";

export type PermissionRequestOwner = { provider: AiProvider; taskId?: string; sessionId?: string };

export function PermissionRequestActions({ request, owner, disabled = false, onResolve }: {
  request: AiPermissionRequest;
  owner: PermissionRequestOwner;
  disabled?: boolean;
  onResolve(owner: PermissionRequestOwner, requestId: string, optionId?: string): Promise<void>;
}) {
  const submittingRef = useRef(false);
  const [submittingOption, setSubmittingOption] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    submittingRef.current = false;
    setSubmittingOption(undefined);
    setError("");
  }, [request.id]);

  const resolve = async (optionId?: string) => {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmittingOption(optionId ?? "__cancel__");
    setError("");
    try {
      await onResolve(owner, request.id, optionId);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Could not resolve permission request");
      submittingRef.current = false;
      setSubmittingOption(undefined);
    }
  };

  const busy = submittingOption !== undefined;
  return <section className="ai-permission" aria-labelledby={`permission-title-${request.id}`}>
    <strong id={`permission-title-${request.id}`}>Permission required</strong>
    <span>{request.title}</span>
    {request.details && <pre>{request.details}</pre>}
    {error && <div className="ai-permission-error" role="alert">{error}</div>}
    <div>{request.options.map((option) => <button type="button" key={option.optionId} className={option.kind.startsWith("reject") ? "reject" : "allow"} disabled={disabled || busy} aria-busy={submittingOption === option.optionId || undefined} onClick={() => void resolve(option.optionId)}>{submittingOption === option.optionId ? "Submitting…" : option.name}</button>)}<button type="button" className="reject" disabled={disabled || busy} aria-busy={submittingOption === "__cancel__" || undefined} onClick={() => void resolve()}>{submittingOption === "__cancel__" ? "Submitting…" : "Cancel"}</button></div>
  </section>;
}
