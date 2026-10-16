import { readFile } from "node:fs/promises";

// Keep failure details available in check annotations when full job logs need
// authentication. The calling step preserves the original test exit status.
const log = await readFile(process.argv[2], "utf8");
const title = (process.argv[3] ?? "Workspace test failure details").replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A").replaceAll(",", "%2C");
const lines = log.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
const selected = new Set();
let sections = 0;
for (let index = 0; index < lines.length && sections < 16; index++) {
  if (!/^(?:not ok\b|\s*✖|\s*FAIL\b)|AssertionError|ERR_ASSERTION/.test(lines[index])) continue;
  sections++;
  for (let cursor = Math.max(0, index - 1); cursor < Math.min(lines.length, index + 24); cursor++) selected.add(cursor);
}
for (let index = Math.max(0, lines.length - 40); index < lines.length; index++) selected.add(index);
const details = [...selected].sort((a, b) => a - b).map((index) => lines[index]).join("\n").slice(-30_000);
for (let start = 0; start < details.length; start += 3_000) {
  const escaped = details.slice(start, start + 3_000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::error title=${title} (part ${start / 3_000 + 1})::${escaped}`);
}
