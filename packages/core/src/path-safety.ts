import path from "node:path";

export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0")) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}
