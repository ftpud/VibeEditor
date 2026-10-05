import type { JavaFileType } from "@remote-ide/protocol";

// This is declaration metadata for explorer icons, not Java type resolution.
export function javaFileType(content: string, name: string): JavaFileType | undefined {
  const code = content.replace(/\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, " ");
  const tokens: string[] = code.match(/[\p{L}_$][\p{L}\p{N}_$]*|[^\s]/gu) ?? [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{") depth++;
    if (token === "}") depth--;
    if (depth === 0 && (token === ";" || token === "}")) start = index + 1;
    if (depth !== 0 || !["class", "interface", "enum", "record"].includes(token!) || tokens[index + 1] !== name) continue;
    const end = tokens.indexOf("{", index + 2);
    const header = tokens.slice(index + 2, end < 0 ? tokens.length : end);
    let angleDepth = 0;
    let parenthesisDepth = 0;
    const inheritance = header.filter((item) => {
      if (item === "<") angleDepth++;
      if (item === ">") angleDepth--;
      if (item === "(") parenthesisDepth++;
      if (item === ")") parenthesisDepth--;
      return angleDepth === 0 && parenthesisDepth === 0;
    });
    const kind = token === "interface" && tokens[index - 1] === "@" ? "annotation" : token as JavaFileType["kind"];
    return { kind, ...(kind === "class" && tokens.slice(start, index).includes("abstract") ? { abstract: true } : {}), ...(inheritance.includes("extends") ? { extends: true } : {}), ...(inheritance.includes("implements") ? { implements: true } : {}) };
  }
  return undefined;
}
