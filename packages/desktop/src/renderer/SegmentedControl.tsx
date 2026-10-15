import type { ReactNode } from "react";

type Option<T extends string> = { value: T; label: string; icon?: ReactNode };
export function SegmentedControl<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange(value: T): void }) {
  return <div className="segmented-control" role="group" aria-label={label} onKeyDown={(event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[next]!.value);
    event.currentTarget.querySelectorAll("button")[next]?.focus();
  }}>{options.map((option) => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.icon}<span>{option.label}</span></button>)}</div>;
}
