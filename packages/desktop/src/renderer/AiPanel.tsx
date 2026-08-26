import { Check, ChevronDown, MessageSquare, Paperclip, Plus, Send, Settings2, Square, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiConfiguration, AiContentBlock, AiModel, AiProvider, AiProviderDescriptor, AiSession, AiUsage } from "@remote-ide/protocol";
import { ModelPicker } from "./ModelPicker";

const AUTOPILOT = /autopilot|auto-?approve|yolo|full[- ]?access|bypass|danger|never ?ask/i;

export type AiAttachment = { id: string; name: string; path?: string; content?: string; data?: string; mimeType?: string };

export function AiPanel({ provider, providers, session, sessions, models, usage, attachments, onProviderChange, onConfigurationChange, onAttachmentsChange, onSend, onSteer, onInterrupt, onNewSession, onSwitchSession, onRemoveSession, onResolvePermission }: { provider: AiProvider; providers: AiProviderDescriptor[]; session: AiSession; sessions: AiSession[]; models: AiModel[]; usage?: AiUsage; attachments: AiAttachment[]; onProviderChange(provider: AiProvider): void; onConfigurationChange(configuration: AiConfiguration): void; onAttachmentsChange(attachments: AiAttachment[]): void; onSend(prompt: string, configuration: AiConfiguration, attachments: AiAttachment[]): Promise<void>; onSteer(prompt: string): Promise<void>; onInterrupt(): void; onNewSession(): void; onSwitchSession(session: AiSession): void; onRemoveSession(session: AiSession): void; onResolvePermission(requestId: string, optionId?: string): void }) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(session.model);
  const [reasoning, setReasoning] = useState(session.reasoning);
  const [configuration, setConfiguration] = useState<AiConfiguration>(session.configuration ?? {});
  const [composerHeight, setComposerHeight] = useState(90);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const shownSessionRef = useRef(session.id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setModel(session.model); setReasoning(session.reasoning); setConfiguration(session.configuration ?? {}); }, [session.model, session.reasoning, session.configuration]);
  const lastMessage = session.messages[session.messages.length - 1];
  // `scrollIntoView` on a trailing anchor scrolls whichever ancestor it finds first, which after a
  // task or session switch is the panel itself, leaving the transcript parked at its old offset.
  // Driving the transcript's own scrollTop keeps the newest message at the bottom where it belongs.
  useLayoutEffect(() => {
    if (shownSessionRef.current !== session.id) { shownSessionRef.current = session.id; pinnedRef.current = true; }
    if (!messagesRef.current || !pinnedRef.current) return;
    // A second pass after paint catches markdown and images that change the height once rendered.
    const scroll = () => { if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight; };
    scroll();
    const frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [session.id, session.messages.length, session.status, lastMessage?.text, session.pendingPermission?.id]);
  const selectedModel = useMemo(() => models.find((item) => item.id === model) ?? models[0], [model, models]);
  useEffect(() => { if (selectedModel && !models.some((item) => item.id === model)) { setModel(selectedModel.id); onConfigurationChange({ ...configuration, model: selectedModel.id, reasoning: selectedModel.reasoningLevels.includes(reasoning) ? reasoning : selectedModel.defaultReasoning }); } }, [model, models, onConfigurationChange, reasoning, selectedModel]);
  useEffect(() => { if (selectedModel && selectedModel.reasoningLevels.length > 0 && !selectedModel.reasoningLevels.includes(reasoning)) { setReasoning(selectedModel.defaultReasoning); onConfigurationChange({ ...configuration, model: selectedModel.id, reasoning: selectedModel.defaultReasoning }); } }, [onConfigurationChange, reasoning, selectedModel]);
  const running = session.status === "in_progress";
  const reasoningLevels = useMemo(() => selectedModel?.reasoningLevels ?? (reasoning ? [reasoning] : []), [reasoning, selectedModel]);
  const descriptor = providers.find((item) => item.id === provider);
  const effectiveOptions = useMemo(() => { const advertised = session.availableOptions ?? []; return [...(descriptor?.options ?? []).filter((option) => !advertised.some((candidate) => candidate.id === option.id)), ...advertised]; }, [descriptor, session.availableOptions]);
  const matchingCommands = useMemo(() => { const token = prompt.split(/\s/, 1)[0] ?? ""; return prompt.startsWith("/") ? (session.availableCommands ?? []).filter((command) => `/${command.name.replace(/^\//, "")}`.startsWith(token)).slice(0, 8) : []; }, [prompt, session.availableCommands]);
  const providerName = descriptor?.name ?? provider;
  // Agents express "approve everything" differently: some advertise a dedicated boolean, others only
  // offer it as one choice of a broader mode option, so both shapes are folded into one switch.
  const autopilot = useMemo(() => {
    const toggle = effectiveOptions.find((option) => option.type === "boolean" && AUTOPILOT.test(`${option.id} ${option.name}`));
    if (toggle) return { option: toggle, on: true as const, off: false as const };
    for (const option of effectiveOptions) {
      if (option.type !== "select" || !option.choices) continue;
      const match = option.choices.find((choice) => AUTOPILOT.test(`${choice.value} ${choice.name}`));
      if (!match) continue;
      const fallback = option.choices.find((choice) => String(option.defaultValue) === choice.value && choice.value !== match.value) ?? option.choices.find((choice) => choice.value !== match.value);
      if (fallback) return { option, on: match.value, off: fallback.value };
    }
    return undefined;
  }, [effectiveOptions]);
  const autopilotOn = autopilot ? String(configuration[autopilot.option.id] ?? autopilot.option.defaultValue) === String(autopilot.on) : false;
  const quickOptionIds = useMemo(() => new Set(autopilot?.option.type === "boolean" ? [autopilot.option.id] : []), [autopilot]);
  const updateConfiguration = (values: AiConfiguration) => { const next = { ...configuration, ...values }; setConfiguration(next); onConfigurationChange({ ...next, model, reasoning }); };
  const changeModel = (nextModel: string) => { const item = models.find((candidate) => candidate.id === nextModel); const nextReasoning = item && item.reasoningLevels.length > 0 && !item.reasoningLevels.includes(reasoning) ? item.defaultReasoning : item && item.reasoningLevels.length === 0 ? "" : reasoning; setModel(nextModel); setReasoning(nextReasoning); onConfigurationChange({ ...configuration, model: nextModel, reasoning: nextReasoning }); };
  const changeReasoning = (nextReasoning: string) => { setReasoning(nextReasoning); onConfigurationChange({ ...configuration, model, reasoning: nextReasoning }); };
  const send = async () => {
    if (!prompt.trim() && (attachments.length === 0 || running)) return;
    const value = prompt;
    setPrompt("");
    try { if (running) await onSteer(value); else { await onSend(value, { ...configuration, model, reasoning }, attachments); onAttachmentsChange([]); } }
    catch { setPrompt(value); }
  };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setAttachmentError("");
    const added: AiAttachment[] = [];
    for (const file of [...files]) {
      if (file.type.startsWith("image/")) added.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type, data: await readBase64(file) });
      else if (isTextFile(file)) added.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type || "text/plain", content: await file.text() });
      else setAttachmentError(`${file.name} is a binary file type that this ACP prompt cannot embed.`);
    }
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
    <div className={`ai-toolbar${autopilot ? " with-autopilot" : ""}`}>
      <div className="ai-provider-picker"><span>Provider</span><select aria-label="AI provider" value={provider} disabled={running} onChange={(event) => { setSettingsOpen(false); onProviderChange(event.target.value as AiProvider); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <ModelPicker models={models} value={model} label={`${providerName} model`} disabled={running} onChange={changeModel} />
      {autopilot && <div className="ai-autopilot" title={`${autopilot.option.name}: approve every action without asking.`}><span>Auto</span><label className="ai-switch"><input type="checkbox" aria-label="Autopilot" disabled={running} checked={autopilotOn} onChange={(event) => updateConfiguration({ [autopilot.option.id]: event.target.checked ? autopilot.on : autopilot.off })} /><span /></label></div>}
      <button className={settingsOpen ? "active" : ""} title={`${providerName} settings`} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={14} /><ChevronDown className="ai-settings-chevron" size={12} /></button>
      {running ? <button className="ai-interrupt" title={`Stop ${providerName}`} onClick={onInterrupt}><Square size={12} fill="currentColor" /></button> : <button className={sessionsOpen ? "active" : ""} title="Manage sessions" aria-expanded={sessionsOpen} onClick={() => { setSettingsOpen(false); setSessionsOpen((open) => !open); }}><MessageSquare size={14} /></button>}
    </div>
    {sessionsOpen && <section className="ai-sessions">
      <header><strong>Sessions</strong><button onClick={() => { setSessionsOpen(false); onNewSession(); }}><Plus size={13} /> New</button></header>
      <div>{sessions.filter((item) => item.id).map((item, index) => <div className="ai-session-row" key={item.id ?? index}><button className="ai-session-select" onClick={() => { setSessionsOpen(false); onSwitchSession(item); }}>{item.id === session.id && <Check size={13} />}<span><strong>{sessionTitle(item)}</strong><small>{sessionDate(item)}</small></span></button><button className="ai-session-remove" title="Remove session" disabled={sessions.length === 1} onClick={() => onRemoveSession(item)}><Trash2 size={13} /></button></div>)}</div>
    </section>}
    {settingsOpen && descriptor && <section className="ai-settings">
      <header><strong>{descriptor.settings.title}</strong><p>{descriptor.settings.description}</p></header>
      {reasoningLevels.length > 0 && <div className="ai-setting-section"><div className="ai-setting-section-title"><strong>Model</strong><span>Options for the selected model.</span></div><SettingRow name="Reasoning effort" description={selectedModel?.reasoningDescriptions?.[reasoning] ?? "Higher effort can improve difficult tasks, but usually takes longer."}><select aria-label="Reasoning effort" disabled={running} value={reasoningLevels.includes(reasoning) ? reasoning : (selectedModel?.defaultReasoning ?? reasoningLevels[0])} onChange={(event) => changeReasoning(event.target.value)}>{reasoningLevels.map((level) => <option key={level} value={level} title={selectedModel?.reasoningDescriptions?.[level]}>{level}</option>)}</select></SettingRow></div>}
      {[...descriptor.settings.sections, ...(effectiveOptions.some((option) => option.section === "acp") ? [{ id: "acp", name: "Agent options", description: "Settings advertised dynamically by the connected ACP server." }] : [])].map((section) => { const options = effectiveOptions.filter((option) => option.section === section.id && !quickOptionIds.has(option.id)); if (options.length === 0) return null; return <div className="ai-setting-section" key={section.id}><div className="ai-setting-section-title"><strong>{section.name}</strong>{section.description && <span>{section.description}</span>}</div>{options.map((option) => <SettingRow key={option.id} name={option.name} description={option.description}>{option.type === "select" ? <select disabled={running} value={selectValue(option, configuration[option.id])} onChange={(event) => updateConfiguration({ [option.id]: event.target.value })}>{option.choices?.map((choice) => <option key={choice.value} value={choice.value} title={choice.description}>{choice.name}</option>)}</select> : option.type === "boolean" ? <label className="ai-switch"><input type="checkbox" disabled={running} checked={Boolean(configuration[option.id] ?? option.defaultValue)} onChange={(event) => updateConfiguration({ [option.id]: event.target.checked })} /><span /></label> : <input disabled={running} type={option.type} min={option.min} max={option.max} value={String(configuration[option.id] ?? option.defaultValue)} onChange={(event) => updateConfiguration({ [option.id]: option.type === "number" ? Number(event.target.value) : event.target.value })} />}</SettingRow>)}</div>; })}
      {usage?.label && <details className="ai-usage"><summary>Usage information</summary><p>{usage.label}{usage.used !== undefined ? ` ${usage.used.toLocaleString()}${usage.limit !== undefined ? ` / ${usage.limit.toLocaleString()}` : ""} ${usage.unit ?? ""}` : ""}</p>{usage.details && <ul>{Object.entries(usage.details).map(([key, value]) => <li key={key}>{key}: {typeof value === "number" ? value.toLocaleString() : value}</li>)}</ul>}</details>}
    </section>}
    <div className="ai-messages" ref={messagesRef} onScroll={(event) => { const element = event.currentTarget; pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
      {session.messages.length === 0 && <div className="ai-empty">Start a {providerName} task for this workspace.</div>}
      {session.messages.map((message, index) => message.role === "activity" ? <ActivityMessage key={`${message.id}:${index}`} text={message.text} content={message.content} /> : <article key={`${message.id}:${index}`} className={`ai-message ${message.role}`}><header>{message.role === "user" ? "You" : message.role === "assistant" ? providerName : "Error"}</header><div>{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : <pre>{message.text}</pre>}<RichContent content={message.content} /></div></article>)}
      {session.pendingPermission && <section className="ai-permission"><strong>Permission required</strong><span>{session.pendingPermission.title}</span>{session.pendingPermission.details && <pre>{session.pendingPermission.details}</pre>}<div>{session.pendingPermission.options.map((option) => <button key={option.optionId} className={option.kind.startsWith("reject") ? "reject" : "allow"} onClick={() => onResolvePermission(session.pendingPermission!.id, option.optionId)}>{option.name}</button>)}<button className="reject" onClick={() => onResolvePermission(session.pendingPermission!.id)}>Cancel</button></div></section>}
      {running && <div className="ai-working"><span />{providerName} is working...</div>}
    </div>
    <div className="ai-composer-resize-handle" onPointerDown={beginComposerResize} />
    <form className="ai-composer" style={{ height: composerHeight }} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {attachmentError && <div className="ai-attachment-error">{attachmentError}</div>}
      {matchingCommands.length > 0 && <div className="ai-command-menu">{matchingCommands.map((command) => <button type="button" key={command.name} onClick={() => setPrompt(`/${command.name.replace(/^\//, "")} `)}><strong>/{command.name.replace(/^\//, "")}</strong><span>{command.description}{command.inputHint ? ` · ${command.inputHint}` : ""}</span></button>)}</div>}
      {attachments.length > 0 && <div className="ai-attachments">{attachments.map((attachment) => <span className="ai-attachment" key={attachment.id} title={attachment.path ?? attachment.name}><span>{attachment.path ?? attachment.name}</span><button type="button" title={`Remove ${attachment.name}`} onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}</div>}
      <textarea value={prompt} placeholder={running ? (session.steering ? `Steer ${providerName} while it works...` : `Queue a follow-up for ${providerName}...`) : `Ask ${providerName}...`} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <div className="ai-composer-actions"><input ref={fileInputRef} type="file" multiple onChange={(event) => void addFiles(event.target.files)} /><button type="button" title="Attach files" disabled={running} onClick={() => fileInputRef.current?.click()}><Paperclip size={15} /></button><button title={running ? (session.steering ? "Add input to the running turn" : "Queue this for the next turn") : "Send prompt"} disabled={!prompt.trim() && (running || attachments.length === 0)}><Send size={15} /></button></div>
    </form>
  </div>;
}

function sessionTitle(session: AiSession): string {
  const first = session.messages.find((message) => message.role === "user")?.text.trim();
  return first ? (first.length > 46 ? `${first.slice(0, 45)}…` : first) : "New session";
}

function sessionDate(session: AiSession): string {
  const value = session.updatedAt ?? session.createdAt;
  return value ? new Date(value).toLocaleString() : "";
}

function isTextFile(file: File): boolean { return file.type.startsWith("text/") || /(?:json|xml|yaml|javascript|typescript|markdown|csv|toml|sql)$/.test(file.type) || /\.(?:txt|md|json|jsonl|ya?ml|xml|csv|toml|ini|log|tsx?|jsx?|css|html?|sql|py|java|c|cc|cpp|h|hpp|rs|go|sh)$/i.test(file.name); }
function readBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? ""); reader.readAsDataURL(file); }); }

function SettingRow({ name, description, children }: { name: string; description: string; children: React.ReactNode }) {
  return <label className="ai-setting-row"><span><strong>{name}</strong><small>{description}</small></span><span className="ai-setting-control">{children}</span></label>;
}

/** Keeps a select usable when stored configuration references a value the agent no longer offers. */
function selectValue(option: { choices?: { value: string }[]; defaultValue: string | number | boolean }, stored: string | number | boolean | undefined): string {
  const current = stored === undefined ? String(option.defaultValue) : String(stored);
  return option.choices?.some((choice) => choice.value === current) ? current : String(option.defaultValue);
}

function ActivityMessage({ text, content }: { text: string; content?: AiContentBlock[] }) {
  const [firstLine, ...output] = text.split("\n");
  const summary = firstLine?.trim() || "Execution details";
  const reasoning = summary === "Reasoning";
  if (reasoning) {
    const content = output.join("\n");
    const previewLine = output.find((line) => line.trim())?.trim().replace(/\s+/g, " ") || "No reasoning details";
    const preview = previewLine.length > 120 ? `${previewLine.slice(0, 119)}…` : previewLine;
    return <details className="ai-reasoning" aria-label="Reasoning">
      <summary><span>Reasoning</span><div className="ai-reasoning-preview" title={preview}><ReasoningMarkdown>{preview}</ReasoningMarkdown></div></summary>
      <div className="ai-reasoning-content"><ReasoningMarkdown>{content}</ReasoningMarkdown></div>
    </details>;
  }
  return <><details className="ai-activity">
    <summary><span>Execution</span><code>{summary}</code></summary>
    <pre>{output.length > 0 ? output.join("\n") : text}</pre>
  </details><RichContent content={content} /></>;
}

function RichContent({ content }: { content?: AiContentBlock[] }) { return <>{content?.map((block, index) => block.type === "image" ? <img className="ai-content-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt={block.name ?? "ACP image output"} /> : block.type === "resource" || block.type === "resource_link" ? <a className="ai-content-resource" key={index} href={block.uri} title={block.uri}>{block.type === "resource_link" ? block.name : block.name ?? block.uri}</a> : null)}</>; }

function ReasoningMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ strong: ({ children: value }) => <em>{value}</em> }}>{children}</ReactMarkdown>;
}
