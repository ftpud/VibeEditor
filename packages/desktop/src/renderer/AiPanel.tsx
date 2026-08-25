import { Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiModel, AiSession } from "@remote-ide/protocol";

export function AiPanel({ session, models, onSend, onClear }: { session: AiSession; models: AiModel[]; onSend(prompt: string, model: string, reasoning: string): Promise<void>; onClear(): void }) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(session.model);
  const [reasoning, setReasoning] = useState(session.reasoning);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setModel(session.model); setReasoning(session.reasoning); }, [session.model, session.reasoning]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [session.messages.length, session.status]);
  const selectedModel = useMemo(() => models.find((item) => item.id === model) ?? models[0], [model, models]);
  useEffect(() => { if (selectedModel && !selectedModel.reasoningLevels.includes(reasoning)) setReasoning(selectedModel.defaultReasoning); }, [reasoning, selectedModel]);
  const running = session.status === "in_progress";
  const send = async () => { if (!prompt.trim() || running) return; const value = prompt; setPrompt(""); try { await onSend(value, model, reasoning); } catch { setPrompt(value); } };
  return <div className="ai-panel">
    <div className="ai-controls">
      <select aria-label="Codex model" value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Reasoning effort" value={reasoning} onChange={(event) => setReasoning(event.target.value)}>{(selectedModel?.reasoningLevels ?? [reasoning]).map((level) => <option key={level} value={level}>{level}</option>)}</select>
      <button title="Clear Codex context" disabled={running || session.messages.length === 0} onClick={onClear}><Trash2 size={14} /></button>
    </div>
    <div className="ai-messages">
      {session.messages.length === 0 && <div className="ai-empty">Start a Codex task for this workspace.</div>}
      {session.messages.map((message) => message.role === "activity" ? <ActivityMessage key={message.id} text={message.text} /> : <article key={message.id} className={`ai-message ${message.role}`}><header>{message.role === "user" ? "You" : message.role === "assistant" ? "Codex" : "Error"}</header><div>{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : <pre>{message.text}</pre>}</div></article>)}
      {running && <div className="ai-working"><span />Codex is working...</div>}
      <div ref={endRef} />
    </div>
    <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea value={prompt} disabled={running} placeholder="Ask Codex..." onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <button title="Send prompt" disabled={running || !prompt.trim()}><Send size={15} /></button>
    </form>
  </div>;
}

function ActivityMessage({ text }: { text: string }) {
  const [firstLine, ...output] = text.split("\n");
  const summary = firstLine?.trim() || "Execution details";
  return <details className="ai-activity">
    <summary><span>Execution</span><code>{summary}</code></summary>
    <pre>{output.length > 0 ? output.join("\n") : text}</pre>
  </details>;
}
