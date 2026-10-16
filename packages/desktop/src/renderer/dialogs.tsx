import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * In-app replacements for `window.prompt` (unsupported in Electron: it throws)
 * and native `window.confirm`. Call `requestFields`, `requestText` or
 * `requestConfirm` from anywhere; `<DialogHost />` in App renders them.
 */
export type DialogField = { id: string; label: string; defaultValue?: string; placeholder?: string; description?: string; /** Allows an empty value. */ optional?: boolean; /** Fixed choices render as a select. */ choices?: { value: string; label: string }[]; validate?(value: string, values: Record<string, string>): string | undefined };
export type FieldsRequest = { title: string; message?: string; detail?: string; fields: DialogField[]; confirmLabel?: string; danger?: boolean };
export type ConfirmRequest = { title: string; message: string; detail?: string; confirmLabel?: string; danger?: boolean };
type Pending = { id: number; request: FieldsRequest; resolve(values: Record<string, string> | undefined): void };

let queue: Pending[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function requestFields(request: FieldsRequest): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => { queue = [...queue, { id: ++sequence, request, resolve }]; notify(); });
}
/** Resolves to the trimmed value, or undefined when cancelled (or empty, unless `optional`). */
export async function requestText(request: Omit<FieldsRequest, "fields"> & Omit<DialogField, "id">): Promise<string | undefined> {
  const { label, defaultValue, placeholder, description, validate, choices, optional, ...dialog } = request;
  const values = await requestFields({ ...dialog, fields: [{ id: "value", label, defaultValue, placeholder, description, validate, choices, optional }] });
  if (!values) return undefined;
  return optional ? values.value ?? "" : values.value || undefined;
}
export async function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  return (await requestFields({ ...request, fields: [] })) !== undefined;
}

export function DialogHost() {
  const pending = useSyncExternalStore(subscribe, () => queue[0]);
  if (!pending) return null;
  const finish = (values: Record<string, string> | undefined) => { queue = queue.filter((item) => item !== pending); notify(); pending.resolve(values); };
  // Above every other dialog and panel: requests often come from inside them.
  return createPortal(<RequestDialog key={pending.id} request={pending.request} onFinish={finish} />, document.body);
}

function RequestDialog({ request, onFinish }: { request: FieldsRequest; onFinish(values: Record<string, string> | undefined): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(request.fields.map((field) => [field.id, field.defaultValue ?? field.choices?.[0]?.value ?? ""])));
  const [touched, setTouched] = useState(false);
  const first = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const finish = useRef(onFinish); finish.current = onFinish;
  useEffect(() => {
    if (first.current) { first.current.focus(); if (first.current instanceof HTMLInputElement) first.current.select(); }
    else confirmButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish.current(undefined); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const errors = Object.fromEntries(request.fields.map((field) => [field.id, !values[field.id]?.trim() ? (field.optional ? undefined : `${field.label} is required`) : field.validate?.(values[field.id]!.trim(), values)]));
  const invalid = request.fields.some((field) => errors[field.id]);
  const submit = () => { setTouched(true); if (!invalid) onFinish(Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value.trim()]))); };
  const confirmation = request.fields.length === 0;
  return <div className="dialog-overlay app-request-overlay" onMouseDown={() => onFinish(undefined)}>
    <section className="run-config-dialog app-request-dialog" role={confirmation ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="app-request-title" aria-describedby={request.message ? "app-request-message" : undefined} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="app-request-title">{request.title}</h2></div><button type="button" aria-label="Close" title="Close" onClick={() => onFinish(undefined)}><X size={15} /></button></header>
      <form className="git-rollback-content" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {request.message && <p id="app-request-message">{request.message}</p>}
        {request.detail && <pre className="app-request-detail">{request.detail}</pre>}
        {request.fields.map((field, index) => <label className="app-request-field" key={field.id}>
          <span>{field.label}</span>
          {field.choices ? <select ref={index === 0 ? first : undefined} value={values[field.id]} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}>{field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
            : <input ref={index === 0 ? first : undefined} value={values[field.id]} placeholder={field.placeholder} aria-invalid={touched && !!errors[field.id]} spellCheck={false} onChange={(event) => { setTouched(true); setValues((current) => ({ ...current, [field.id]: event.target.value })); }} />}
          {touched && errors[field.id] ? <small className="app-request-error" role="alert">{errors[field.id]}</small> : field.description && <small>{field.description}</small>}
        </label>)}
        <footer><button type="button" onClick={() => onFinish(undefined)}>Cancel</button><button ref={confirmButton} type="submit" className={request.danger ? "danger" : "primary"} disabled={touched && invalid}>{request.confirmLabel ?? (confirmation ? "Continue" : "OK")}</button></footer>
      </form>
    </section>
  </div>;
}

/** Git ref names: no spaces, `..`, control characters, `~^:?*[\` or trailing `.lock`/`/`/`.`. */
export function gitRefNameError(value: string): string | undefined {
  if (/\s/.test(value)) return "Spaces are not allowed";
  if (/\.\.|[~^:?*[\\\x00-\x1f\x7f]|@\{|\/\/|^[/.-]|[/.]$|\.lock$|\/\./.test(value) || value === "@") return "Not a valid Git name";
  return undefined;
}
