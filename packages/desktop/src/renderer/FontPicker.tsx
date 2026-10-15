import { Check, ChevronDown, Type } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Font = "inter" | "jetbrains";
const fonts: { value: Font; label: string; description: string }[] = [
  { value: "inter", label: "Inter", description: "Clean, proportional interface" },
  { value: "jetbrains", label: "JetBrains Mono", description: "Precise, monospaced interface" },
];
export function FontPicker({ value, onChange }: { value: Font; onChange(value: Font): void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight || 170;
    setPosition({ left: Math.max(8, Math.min(anchor.right - 250, window.innerWidth - 258)), top: anchor.bottom + height + 8 < window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6) });
    menu.current?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const reposition = () => setOpen(false);
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", reposition);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", reposition); };
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <>
    <button ref={trigger} className="font-picker-trigger" aria-label="Font" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}><Type size={14} /><span>{fonts.find((font) => font.value === value)?.label}</span><ChevronDown size={13} /></button>
    {open && createPortal(<div ref={menu} className="font-picker-menu" data-settings-popover role="listbox" aria-label="Interface font" style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]")];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      }
    }}><header>Interface font</header>{fonts.map((font) => <button className={`font-picker-option font-${font.value}`} data-value={font.value} key={font.value} role="option" aria-selected={value === font.value} onClick={() => { onChange(font.value); close(); }}><div><strong>{font.label}</strong><small>{font.description}</small><span className="font-picker-sample">Aa Bb Cc 0123</span></div>{value === font.value && <Check size={15} />}</button>)}</div>, document.body)}
  </>;
}
