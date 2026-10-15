import { Braces, File, FileCode2, FileJson, FileText, Hash } from "lucide-react";
import type { JavaFileType } from "@remote-ide/protocol";
import { JavaFileIcon } from "./JavaFileIcon";

export function FileKindIcon({ name, javaType }: { name: string; javaType?: JavaFileType }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const appearance: Record<string, { color: string; Icon: typeof File }> = {
    ts: { color: "var(--accent)", Icon: FileCode2 }, tsx: { color: "var(--accent)", Icon: FileCode2 }, js: { color: "var(--warning)", Icon: FileCode2 }, jsx: { color: "var(--warning)", Icon: FileCode2 }, json: { color: "var(--warning)", Icon: FileJson }, xml: { color: "var(--warning)", Icon: FileCode2 }, html: { color: "var(--warning)", Icon: FileCode2 }, css: { color: "var(--purple)", Icon: Hash }, md: { color: "var(--accent)", Icon: FileText }, py: { color: "var(--success)", Icon: FileCode2 }, yaml: { color: "var(--danger)", Icon: Braces }, yml: { color: "var(--danger)", Icon: Braces }, mta: { color: "var(--danger)", Icon: Braces }, mtaext: { color: "var(--danger)", Icon: Braces }, cds: { color: "var(--cyan)", Icon: FileCode2 }
  };
  const { color, Icon } = appearance[extension] ?? { color: "var(--text-muted)", Icon: File };
  return extension === "java" ? <JavaFileIcon type={javaType} /> : <Icon className="file-kind-icon" color={color} size={14} />;
}
