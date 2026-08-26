import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AiModel } from "@remote-ide/protocol";

/**
 * Catalogue-aware model chooser. ACP agents advertise more than a name: Copilot
 * publishes a premium-request multiplier and availability, Codex publishes
 * descriptions and context windows, so the list shows those instead of hiding
 * them behind a plain `<select>`.
 */
export function ModelPicker({ models, value, label, disabled, onChange }: { models: AiModel[]; value: string; label: string; disabled?: boolean; onChange(model: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.id === value);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => `${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase().includes(needle));
  }, [models, query]);

  useEffect(() => { if (!open) { setQuery(""); return; } setActive(Math.max(0, models.findIndex((model) => model.id === value))); searchRef.current?.focus(); }, [models, open, value]);
  useEffect(() => { setActive((index) => Math.min(index, Math.max(0, visible.length - 1))); }, [visible.length]);
  useEffect(() => { if (open) listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (model: AiModel) => { setOpen(false); if (model.id !== value) onChange(model.id); };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (visible.length === 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length));
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); const model = visible[active]; if (model) choose(model); }
  };

  return <div className="ai-model-picker" ref={rootRef}>
    <span>Model</span>
    <button type="button" className="ai-model-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
      <span className="ai-model-trigger-name">{selected?.name ?? value ?? "Select a model"}</span>
      {selected?.price && <span className={`ai-model-price ${tierClass(selected)}`}>{selected.price}</span>}
      <ChevronDown size={12} />
    </button>
    {open && <div className="ai-model-menu" role="listbox" onKeyDown={keyDown}>
      <div className="ai-model-search"><Search size={13} /><input ref={searchRef} value={query} placeholder="Search models" onChange={(event) => { setQuery(event.target.value); setActive(0); }} /></div>
      <div className="ai-model-list" ref={listRef}>
        {visible.length === 0 && <div className="ai-model-empty">No model matches “{query}”.</div>}
        {visible.map((model, index) => <div
          key={model.id}
          role="option"
          aria-selected={model.id === value}
          data-active={index === active}
          className={`ai-model-item${model.id === value ? " selected" : ""}${model.available === false ? " unavailable" : ""}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(model)}
        >
          <div className="ai-model-item-head">
            <span className="ai-model-item-name">{model.name}</span>
            {model.price && <span className={`ai-model-price ${tierClass(model)}`} title={priceTitle(model)}>{model.price}</span>}
            {model.contextWindow && <span className="ai-model-tag" title={contextTitle(model)}>{compact(model.contextWindow)} ctx</span>}
            {model.available === false && <span className="ai-model-tag warn">unavailable</span>}
            {model.id === value && <Check className="ai-model-check" size={13} />}
          </div>
          {model.description && <p className="ai-model-item-description">{model.description}</p>}
          <div className="ai-model-item-meta">
            {model.reasoningLevels.length > 0 && <span>effort: {model.reasoningLevels.join(", ")}</span>}
            {model.inputModalities && model.inputModalities.length > 0 && <span>input: {model.inputModalities.join(", ")}</span>}
          </div>
          {model.note && <p className="ai-model-item-note">{model.note}</p>}
        </div>)}
      </div>
    </div>}
  </div>;
}

function tierClass(model: AiModel): string { return model.priceTier ? `tier-${model.priceTier.replace(/[^a-z]+/gi, "-").toLowerCase()}` : ""; }
function priceTitle(model: AiModel): string { return `Costs ${model.price} of a request${model.priceTier ? ` (${model.priceTier.replace(/_/g, " ")} cost)` : ""}`; }
function contextTitle(model: AiModel): string { return `Context window: ${model.contextWindow?.toLocaleString()} tokens${model.maxContextWindow ? ` (up to ${model.maxContextWindow.toLocaleString()})` : ""}`; }

/** 272000 -> "272K", 1000000 -> "1M". */
function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
