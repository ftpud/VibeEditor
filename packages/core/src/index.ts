import { createServer } from "./server.js";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const host = option("host", "127.0.0.1");
const port = Number(option("port", "7331"));
const workspace = option("workspace", "");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Port must be an integer between 1 and 65535");
  process.exit(1);
}
if (!workspace) {
  console.error("A workspace is required. Pass --workspace /absolute/path/to/workspace");
  process.exit(1);
}

try {
  await createServer(host, port, workspace);
} catch (error) {
  console.error(`[core] failed to open workspace: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
