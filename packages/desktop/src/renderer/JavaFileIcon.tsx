import { Coffee } from "lucide-react";
import type { JavaFileType } from "@remote-ide/protocol";

export function JavaFileIcon({ type }: { type?: JavaFileType }) {
  if (!type) return <Coffee className="file-kind-icon java-generic-icon" size={14} />;
  const label = type.abstract ? "Abstract class" : type.kind[0]!.toUpperCase() + type.kind.slice(1);
  const title = `${label}${type.extends ? " · extends a type" : ""}${type.implements ? " · implements interfaces" : ""}`;
  const letter = type.abstract ? "A" : type.kind === "annotation" ? "@" : type.kind[0]!.toUpperCase();
  return <svg className={`file-kind-icon java-type-icon java-type-${type.kind}`} width="14" height="14" viewBox="0 0 16 16" role="img" aria-label={title}>
    <title>{title}</title>
    <circle cx="7.5" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1" />
    <text x="7.5" y="8.5" textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontFamily="sans-serif" fontSize="9" fontWeight="400">{letter}</text>
    {type.extends && <path d="M11 5V1m-2 2 2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}
