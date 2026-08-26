import { ChevronDown, Paperclip, Send, Settings2, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiConfiguration, AiModel, AiProvider, AiProviderDescriptor, AiSession, AiUsage } from "@remote-ide/protocol";

export type AiAttachment = { id: string; name: string; path?: string; content?: string };

export function AiPanel({ provider, providers, session, models, usage, attachments, onProviderChange, onConfigurationChange, onAttachmentsChange, onSend, onInterrupt, onClear }: { provider: AiProvider; providers: AiProviderDescriptor[]; session: AiSession; models: AiModel[]; usage?: AiUsage; attachments: AiAttachment[]; onProviderChange(provider: AiProvider): void; onConfigurationChange(configuration: AiConfiguration): void; onAttachmentsChange(attachments: AiAttachment[]): void; onSend(prompt: string, configuration: AiConfiguration, attachments: AiAttachment[]): Promise<void>; onInterrupt(): void; onClear(): void }) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(session.model);
  const [reasoning, setReasoning] = useState(session.reasoning);
  const [configuration, setConfiguration] = useState<AiConfiguration>(session.configuration ?? {});
  const [composerHeight, setComposerHeight] = useState(90);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setModel(session.model); setReasoning(session.reasoning); setConfiguration(session.configuration ?? {}); }, [session.model, session.reasoning, session.configuration]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [session.messages.length, session.status]);
  const selectedModel = useMemo(() => models.find((item) => item.id === model) ?? models[0], [model, models]);
  useEffect(() => { if (selectedModel && !models.some((item) => item.id === model)) { setModel(selectedModel.id); onConfigurationChange({ ...configuration, model: selectedModel.id, reasoning: selectedModel.reasoningLevels.includes(reasoning) ? reasoning : selectedModel.defaultReasoning }); } }, [model, models, onConfigurationChange, reasoning, selectedModel]);
  useEffect(() => { if (selectedModel && !selectedModel.reasoningLevels.includes(reasoning)) { setReasoning(selectedModel.defaultReasoning); onConfigurationChange({ ...configuration, model: selectedModel.id, reasoning: selectedModel.defaultReasoning }); } }, [onConfigurationChange, reasoning, selectedModel]);
  const running = session.status === "in_progress";
  const descriptor = providers.find((item) => item.id === provider);
  const providerName = descriptor?.name ?? provider;
  const updateConfiguration = (values: AiConfiguration) => { const next = { ...configuration, ...values }; setConfiguration(next); onConfigurationChange({ ...next, model, reasoning }); };
  const changeModel = (nextModel: string) => { const item = models.find((candidate) => candidate.id === nextModel); const nextReasoning = item && !item.reasoningLevels.includes(reasoning) ? item.defaultReasoning : reasoning; setModel(nextModel); setReasoning(nextReasoning); onConfigurationChange({ ...configuration, model: nextModel, reasoning: nextReasoning }); };
  const changeReasoning = (nextReasoning: string) => { setReasoning(nextReasoning); onConfigurationChange({ ...configuration, model, reasoning: nextReasoning }); };
  const send = async () => { if ((!prompt.trim() && attachments.length === 0) || running) return; const value = prompt; setPrompt(""); try { await onSend(value, { ...configuration, model, reasoning }, attachments); onAttachmentsChange([]); } catch { setPrompt(value); } };
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
    <div className="ai-toolbar">
      <div className="ai-provider-picker"><span>Provider</span><select aria-label="AI provider" value={provider} disabled={running} onChange={(event) => { setSettingsOpen(false); onProviderChange(event.target.value as AiProvider); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="ai-model-picker"><span>Model</span><select aria-label={`${providerName} model`} value={model} disabled={running} onChange={(event) => changeModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <button className={settingsOpen ? "active" : ""} title={`${providerName} settings`} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={14} /><ChevronDown className="ai-settings-chevron" size={12} /></button>
      {running ? <button className="ai-interrupt" title={`Stop ${providerName}`} onClick={onInterrupt}><Square size={12} fill="currentColor" /></button> : <button className="ai-clear" title={`Clear ${providerName} conversation`} disabled={session.messages.length === 0} onClick={onClear}><Trash2 size={14} /></button>}
    </div>
    {settingsOpen && descriptor && <section className="ai-settings">
      <header><strong>{descriptor.settings.title}</strong><p>{descriptor.settings.description}</p></header>
      <div className="ai-setting-section"><div className="ai-setting-section-title"><strong>Model behavior</strong><span>Controls the depth of analysis before the agent responds.</span></div><SettingRow name="Reasoning effort" description="Higher effort can improve difficult tasks, but usually takes longer."><select aria-label="Reasoning effort" value={reasoning} disabled={running} onChange={(event) => changeReasoning(event.target.value)}>{(selectedModel?.reasoningLevels ?? [reasoning]).map((level) => <option key={level} value={level}>{level}</option>)}</select></SettingRow></div>
      {descriptor.settings.sections.map((section) => { const options = descriptor.options.filter((option) => option.section === section.id); if (options.length === 0) return null; return <div className="ai-setting-section" key={section.id}><div className="ai-setting-section-title"><strong>{section.name}</strong>{section.description && <span>{section.description}</span>}</div>{options.map((option) => <SettingRow key={option.id} name={option.name} description={option.description}>{option.type === "select" ? <select disabled={running} value={String(configuration[option.id] ?? option.defaultValue)} onChange={(event) => updateConfiguration({ [option.id]: event.target.value })}>{option.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}</select> : option.type === "boolean" ? <label className="ai-switch"><input type="checkbox" disabled={running} checked={Boolean(configuration[option.id] ?? option.defaultValue)} onChange={(event) => updateConfiguration({ [option.id]: event.target.checked })} /><span /></label> : <input disabled={running} type={option.type} min={option.min} max={option.max} value={String(configuration[option.id] ?? option.defaultValue)} onChange={(event) => updateConfiguration({ [option.id]: option.type === "number" ? Number(event.target.value) : event.target.value })} />}</SettingRow>)}</div>; })}
      {usage?.label && <details className="ai-usage"><summary>Usage information</summary><p>{usage.label}{usage.used !== undefined ? ` ${usage.used}${usage.limit !== undefined ? ` / ${usage.limit}` : ""} ${usage.unit ?? ""}` : ""}</p></details>}
    </section>}
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

function SettingRow({ name, description, children }: { name: string; description: string; children: React.ReactNode }) {
  return <label className="ai-setting-row"><span><strong>{name}</strong><small>{description}</small></span><span className="ai-setting-control">{children}</span></label>;
}

function ActivityMessage({ text }: { text: string }) {
  const [firstLine, ...output] = text.split("\n");
  const summary = firstLine?.trim() || "Execution details";
  return <details className="ai-activity">
    <summary><span>Execution</span><code>{summary}</code></summary>
    <pre>{output.length > 0 ? output.join("\n") : text}</pre>
  </details>;
}
