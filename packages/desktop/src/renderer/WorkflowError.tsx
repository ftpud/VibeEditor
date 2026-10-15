import { CircleAlert } from "lucide-react";

export function WorkflowError({ message, label = "Error" }: { message: string; label?: string }) {
  return <details className="workflow-error" aria-label={`${label} details`}>
    <summary><CircleAlert size={13} aria-hidden="true" /><span>{label}: <span role="alert">{message.replace(/\s+/g, " ").slice(0, 240)}</span></span></summary>
    <pre tabIndex={0}>{message}</pre>
  </details>;
}
