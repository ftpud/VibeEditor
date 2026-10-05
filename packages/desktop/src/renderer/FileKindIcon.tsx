import { Braces, File, FileCode2, FileJson, FileText, Hash } from "lucide-react";
import type { JavaFileType } from "@remote-ide/protocol";
import { JavaFileIcon } from "./JavaFileIcon";

export function FileKindIcon({ name, javaType }: { name: string; javaType?: JavaFileType }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const appearance: Record<string, { color: string; Icon: typeof File }> = {
    ts: { color: "#5e9fd6", Icon: FileCode2 }, tsx: { color: "#5e9fd6", Icon: FileCode2 }, js: { color: "#d9c65c", Icon: FileCode2 }, jsx: { color: "#d9c65c", Icon: FileCode2 }, json: { color: "#c9b45d", Icon: FileJson }, xml: { color: "#d7a85e", Icon: FileCode2 }, html: { color: "#e8845b", Icon: FileCode2 }, css: { color: "#8d7bd8", Icon: Hash }, md: { color: "#78a7cf", Icon: FileText }, py: { color: "#63a86f", Icon: FileCode2 }, yaml: { color: "#ca6b75", Icon: Braces }, yml: { color: "#ca6b75", Icon: Braces }, mta: { color: "#ca6b75", Icon: Braces }, mtaext: { color: "#ca6b75", Icon: Braces }, cds: { color: "#5aa7a0", Icon: FileCode2 }
  };
  const { color, Icon } = appearance[extension] ?? { color: "#9aa0a8", Icon: File };
  return extension === "java" ? <JavaFileIcon type={javaType} /> : <Icon className="file-kind-icon" color={color} size={14} />;
}
