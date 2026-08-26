import { Paperclip, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiModel, AiProvider, AiSession } from "@remote-ide/protocol";

export type AiAttachment = { id: string; name: string; path?: string; content?: string };

export function AiPanel({ provider, session, models, attachments, onProviderChange, onConfigurationChange, onAttachmentsChange, onSend, onClear }: { provider: AiProvider; session: AiSession; models: AiModel[]; attachments: AiAttachment[]; onProviderChange(provider: AiProvider): void; onConfigurationChange(model: string, reasoning: string): void; onAttachmentsChange(attachments: AiAttachment[]): void; onSend(prompt: string, model: string, reasoning: string, attachments: AiAttachment[]): Promise<void>; onClear(): void }) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(session.model);
  const [reasoning, setReasoning] = useState(session.reasoning);
  const [composerHeight, setComposerHeight] = useState(90);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setModel(session.model); setReasoning(session.reasoning); }, [session.model, session.reasoning]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [session.messages.length, session.status]);
  const selectedModel = useMemo(() => models.find((item) => item.id === model) ?? models[0], [model, models]);
  useEffect(() => { if (selectedModel && !models.some((item) => item.id === model)) { setModel(selectedModel.id); onConfigurationChange(selectedModel.id, selectedModel.reasoningLevels.includes(reasoning) ? reasoning : selectedModel.defaultReasoning); } }, [model, models, onConfigurationChange, reasoning, selectedModel]);
  useEffect(() => { if (selectedModel && !selectedModel.reasoningLevels.includes(reasoning)) { setReasoning(selectedModel.defaultReasoning); onConfigurationChange(selectedModel.id, selectedModel.defaultReasoning); } }, [onConfigurationChange, reasoning, selectedModel]);
  const running = session.status === "in_progress";
  const providerName = provider === "codex" ? "Codex CLI" : "Copilot CLI";
  const changeModel = (nextModel: string) => { const item = models.find((candidate) => candidate.id === nextModel); const nextReasoning = item && !item.reasoningLevels.includes(reasoning) ? item.defaultReasoning : reasoning; setModel(nextModel); setReasoning(nextReasoning); onConfigurationChange(nextModel, nextReasoning); };
  const changeReasoning = (nextReasoning: string) => { setReasoning(nextReasoning); onConfigurationChange(model, nextReasoning); };
  const send = async () => { if ((!prompt.trim() && attachments.length === 0) || running) return; const value = prompt; setPrompt(""); try { await onSend(value, model, reasoning, attachments); onAttachmentsChange([]); } catch { setPrompt(value); } };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const added = await Promise.all([...files].map(async (file) => ({ id: crypto.randomUUID(), name: file.name, content: await file.text() })));
    onAttachmentsChange([...attachments, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const beginComposerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = composerHeight;
    const move = (moveEvent: PointerEvent) => setComposerHeight(Math.max(78, Math.min(Math.min(420, window.innerHeight * 0.55), startHeight + startY - moveEvent.clientY)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  return <div className="ai-panel">
    <div className="ai-controls">
      <select aria-label="AI provider" value={provider} disabled={running} onChange={(event) => onProviderChange(event.target.value as AiProvider)}><option value="codex">Codex</option><option value="copilot">Copilot CLI</option></select>
      <select aria-label={`${providerName} model`} value={model} disabled={running} onChange={(event) => changeModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Reasoning effort" value={reasoning} disabled={running} onChange={(event) => changeReasoning(event.target.value)}>{(selectedModel?.reasoningLevels ?? [reasoning]).map((level) => <option key={level} value={level}>{level}</option>)}</select>
      <button title={`Clear ${providerName} context`} disabled={running || session.messages.length === 0} onClick={onClear}><Trash2 size={14} /></button>
    </div>
    <div className="ai-messages">
      {session.messages.length === 0 && <div className="ai-empty">Start a {providerName} task for this workspace.</div>}
      {session.messages.map((message) => message.role === "activity" ? <ActivityMessage key={message.id} text={message.text} /> : <article key={message.id} className={`ai-message ${message.role}`}><header>{message.role === "user" ? "You" : message.role === "assistant" ? providerName : "Error"}</header><div>{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : <pre>{message.text}</pre>}</div></article>)}
      {running && <div className="ai-working"><span />{providerName} is working...</div>}
      <div ref={endRef} />
    </div>
    <div className="ai-composer-resize-handle" onPointerDown={beginComposerResize} />
    <form className="ai-composer" style={{ height: composerHeight }} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {attachments.length > 0 && <div className="ai-attachments">{attachments.map((attachment) => <span className="ai-attachment" key={attachment.id} title={attachment.path ?? attachment.name}><span>{attachment.path ?? attachment.name}</span><button type="button" title={`Remove ${attachment.name}`} onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}</div>}
      <textarea value={prompt} disabled={running} placeholder={`Ask ${providerName}...`} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <div className="ai-composer-actions"><input ref={fileInputRef} type="file" multiple onChange={(event) => void addFiles(event.target.files)} /><button type="button" title="Attach files" disabled={running} onClick={() => fileInputRef.current?.click()}><Paperclip size={15} /></button><button title="Send prompt" disabled={running || (!prompt.trim() && attachments.length === 0)}><Send size={15} /></button></div>
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
