import { useEffect, useRef, useState } from "react";
import type { AiQuestionAction, AiQuestionAnswer, AiQuestionField, AiQuestionRequest } from "@remote-ide/protocol";
import type { PermissionRequestOwner } from "./PermissionRequestActions";

type Value = string | number | boolean | string[];

function initialValues(fields: AiQuestionField[]): Record<string, Value> {
  return Object.fromEntries(fields.flatMap((field) => field.defaultValue !== undefined ? [[field.id, field.defaultValue]] : field.type === "multi" ? [[field.id, []]] : field.type === "boolean" ? [[field.id, false]] : []));
}

/** Drops empty values and converts numeric text, so the answer matches the agent's schema. */
export function questionAnswer(fields: AiQuestionField[], values: Record<string, Value>): AiQuestionAnswer {
  const answer: AiQuestionAnswer = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if ((field.type === "number" || field.type === "integer") && typeof value === "string") { const number = Number(value); if (Number.isFinite(number)) answer[field.id] = field.type === "integer" ? Math.trunc(number) : number; continue; }
    answer[field.id] = value;
  }
  return answer;
}

/** A form-mode question from the agent. The turn waits until it is submitted, declined or cancelled. */
export function QuestionRequestForm({ request, owner, disabled = false, onAnswer }: {
  request: AiQuestionRequest;
  owner: PermissionRequestOwner;
  disabled?: boolean;
  onAnswer(owner: PermissionRequestOwner, requestId: string, action: AiQuestionAction, answer?: AiQuestionAnswer): Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, Value>>(() => initialValues(request.fields));
  const [submitting, setSubmitting] = useState<AiQuestionAction>();
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  // Session refreshes deliver a new fields array for the same question; only a new question resets the form.
  useEffect(() => { setValues(initialValues(request.fields)); setSubmitting(undefined); setError(""); formRef.current?.focus(); }, [request.id]);
  const set = (id: string, value: Value) => setValues((current) => ({ ...current, [id]: value }));
  const missing = request.fields.some((field) => field.required && questionAnswer([field], values)[field.id] === undefined);
  const submit = async (action: AiQuestionAction) => {
    if (disabled || submitting) return;
    setSubmitting(action); setError("");
    try { await onAnswer(owner, request.id, action, action === "accept" ? questionAnswer(request.fields, values) : undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not send the answer"); setSubmitting(undefined); }
  };
  const titleId = `question-title-${request.id}`;
  return <form ref={formRef} className="ai-question" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-busy={submitting !== undefined} tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void submit("accept"); }}>
    <strong id={titleId}>The agent has a question</strong>
    <p>{request.message}</p>
    {request.fields.map((field) => <fieldset key={field.id} disabled={disabled || submitting !== undefined}>
      <legend>{field.title ?? field.id}{field.required ? " *" : ""}</legend>
      {field.description && <small>{field.description}</small>}
      {field.type === "choice" && <div className="ai-question-choices" role="radiogroup" aria-label={field.title ?? field.id}>{field.choices?.map((choice) => <label key={choice.value} title={choice.description}><input type="radio" name={`${request.id}:${field.id}`} checked={values[field.id] === choice.value} onChange={() => set(field.id, choice.value)} /><span>{choice.label}{choice.description && <small>{choice.description}</small>}</span></label>)}</div>}
      {field.type === "multi" && <div className="ai-question-choices" role="group" aria-label={field.title ?? field.id}>{field.choices?.map((choice) => { const selected = Array.isArray(values[field.id]) ? values[field.id] as string[] : []; return <label key={choice.value} title={choice.description}><input type="checkbox" checked={selected.includes(choice.value)} onChange={(event) => set(field.id, event.target.checked ? [...selected, choice.value] : selected.filter((item) => item !== choice.value))} /><span>{choice.label}{choice.description && <small>{choice.description}</small>}</span></label>; })}</div>}
      {field.type === "boolean" && <label className="ai-question-toggle"><input type="checkbox" checked={values[field.id] === true} onChange={(event) => set(field.id, event.target.checked)} /><span>Yes</span></label>}
      {field.type === "text" && <textarea aria-label={field.title ?? field.id} rows={2} value={typeof values[field.id] === "string" ? values[field.id] as string : ""} onChange={(event) => set(field.id, event.target.value)} />}
      {(field.type === "number" || field.type === "integer") && <input aria-label={field.title ?? field.id} type="number" step={field.type === "integer" ? 1 : "any"} value={values[field.id] === undefined ? "" : String(values[field.id])} onChange={(event) => set(field.id, event.target.value)} />}
    </fieldset>)}
    {error && <div className="ai-permission-error" role="alert">{error}</div>}
    <div className="ai-question-actions">
      <button type="submit" className="allow" disabled={disabled || submitting !== undefined || missing}>{submitting === "accept" ? "Sending…" : "Answer"}</button>
      <button type="button" className="reject" disabled={disabled || submitting !== undefined} onClick={() => void submit("decline")}>{submitting === "decline" ? "Sending…" : "Skip"}</button>
      <button type="button" className="reject" disabled={disabled || submitting !== undefined} onClick={() => void submit("cancel")}>{submitting === "cancel" ? "Sending…" : "Cancel"}</button>
    </div>
  </form>;
}
