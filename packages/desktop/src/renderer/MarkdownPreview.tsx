import type { MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownLink =
  | { type: "external"; url: string }
  | { type: "file"; path: string }
  | { type: "fragment"; id: string }
  | { type: "unsupported" };

export function resolveMarkdownLink(href: string, sourcePath: string, workspacePath = ""): MarkdownLink {
  if (href.startsWith("#")) {
    try { return { type: "fragment", id: decodeURIComponent(href.slice(1)) }; }
    catch { return { type: "unsupported" }; }
  }

  let url: URL;
  try { url = new URL(href); }
  catch {
    const target = href.split(/[?#]/, 1)[0];
    if (!target) return { type: "unsupported" };
    let decoded: string;
    try { decoded = decodeURIComponent(target).replaceAll("\\", "/"); }
    catch { return { type: "unsupported" }; }
    const base = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const path = normalizeWorkspacePath(decoded.startsWith("/") ? decoded.slice(1) : `${base}/${decoded}`);
    return path ? { type: "file", path } : { type: "unsupported" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") return { type: "external", url: url.toString() };
  if (url.protocol !== "file:" || url.host) return { type: "unsupported" };

  let filePath: string;
  try { filePath = decodeURIComponent(url.pathname).replaceAll("\\", "/"); }
  catch { return { type: "unsupported" }; }
  const workspace = workspacePath.replaceAll("\\", "/").replace(/\/$/, "");
  if (!workspace || (filePath !== workspace && !filePath.startsWith(`${workspace}/`))) return { type: "unsupported" };
  const path = normalizeWorkspacePath(filePath.slice(workspace.length + 1));
  return path ? { type: "file", path } : { type: "unsupported" };
}

function normalizeWorkspacePath(value: string): string | undefined {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || undefined;
}

function markdownUrlTransform(url: string, key: string): string {
  if (key === "href" && /^file:/i.test(url)) return url;
  return /^(?:[a-z][a-z+.-]*:)/i.test(url) && !/^(?:https?|ircs?|mailto|xmpp):/i.test(url) ? "" : url;
}

export function MarkdownPreview({ children, sourcePath, workspacePath, renderPre, onOpenFile, onOpenExternal }: {
  children: string;
  sourcePath: string;
  workspacePath?: string;
  renderPre?: Components["pre"];
  onOpenFile(path: string): void;
  onOpenExternal(url: string): void;
}) {
  const followLink = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    event.preventDefault();
    if (!href) return;
    const link = resolveMarkdownLink(href, sourcePath, workspacePath);
    if (link.type === "external") onOpenExternal(link.url);
    else if (link.type === "file") onOpenFile(link.path);
    else if (link.type === "fragment") document.getElementById(link.id)?.scrollIntoView();
  };

  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    urlTransform={markdownUrlTransform}
    components={{
      ...(renderPre ? { pre: renderPre } : {}),
      a: ({ href, children: label, ...props }) => <a {...props} href={href} onClick={(event) => followLink(event, href)}>{label}</a>
    }}
  >{children}</ReactMarkdown>;
}
