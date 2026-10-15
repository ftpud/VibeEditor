import type { AiContextCategory, AiContextEntry, AiContextSection, AiSession } from "@remote-ide/acp";

const PREVIEW_LIMIT = 1600;
const ENTRY_LIMIT = 12;
const HISTORY_LIMIT = 120;
const categories: AiContextCategory[] = ["instructions", "conversation", "files", "tools", "reasoning"];

function entry(id: string, label: string, text: string, timestamp: string): AiContextEntry {
  return { id, label: label.slice(0, 160), characters: text.length, preview: text.slice(0, PREVIEW_LIMIT), timestamp };
}

/** Record only instructions Vibe actually injected, never inferred system prompts. */
export function captureContextInstructions(session: AiSession, label: string, text: string): void {
  refreshContext(session);
  const section = session.context!.sections.find((item) => item.id === "instructions")!;
  section.characters += text.length;
  section.count++;
  section.entries = [...section.entries, entry(`instruction-${section.count}`, label, text, new Date().toISOString())].slice(-ENTRY_LIMIT);
}

/** Rebuild from retained history: streamed tool replacements must not count twice. */
export function refreshContext(session: AiSession, sampleUsage = false): void {
  const sections: AiContextSection[] = categories.map((id) => id === "instructions"
    ? session.context?.sections.find((item) => item.id === id) ?? { id, characters: 0, count: 0, entries: [] }
    : { id, characters: 0, count: 0, entries: [] });
  const add = (category: AiContextCategory, item: AiContextEntry) => {
    const section = sections.find((section) => section.id === category)!;
    section.characters += item.characters; section.count++;
    section.entries.push(item);
    if (section.entries.length > ENTRY_LIMIT) section.entries.shift();
  };
  for (const message of session.messages.slice(-1000)) {
    if (message.role === "error") continue;
    const category = message.role === "activity" ? message.contextKind : "conversation";
    // Status notifications and plans are UI activity, not known model context.
    if (!category) continue;
    const newline = message.text.indexOf("\n");
    const label = message.text.slice(0, newline < 0 ? 160 : Math.min(newline, 160));
    add(category, entry(message.id, label || message.role, message.text, message.timestamp));
    for (const [index, content] of (message.content ?? []).entries()) {
      if (content.type === "resource") add("files", entry(`${message.id}:${index}`, content.name ?? content.uri, content.text, message.timestamp));
      // Text content is already represented by message.text. Links and binary
      // attachments have no measurable text size and must not be tokenized as base64.
      if (content.type === "resource_link" || content.type === "image") add("files", {
        id: `${message.id}:${index}`, label: content.name ?? "Image", characters: 0,
        preview: content.type === "image" ? "Image: token size unavailable." : `Resource link: ${content.uri}. Contents not captured.`, timestamp: message.timestamp,
      });
    }
  }
  let history = session.context?.history ?? [];
  if (sampleUsage && Number.isFinite(session.contextUsed) && session.contextUsed! >= 0) {
    const characters = sections.reduce((total, item) => total + item.characters, 0);
    const previous = history.at(-1);
    if (!previous || previous.used !== session.contextUsed || previous.limit !== session.contextLimit || previous.characters !== characters) {
      history = [...history, { timestamp: new Date().toISOString(), used: session.contextUsed!, limit: session.contextLimit, characters }].slice(-HISTORY_LIMIT);
    }
  }
  session.context = { sections, history, compactions: session.context?.compactions ?? 0 };
}
