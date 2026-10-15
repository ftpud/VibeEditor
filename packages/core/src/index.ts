import { loadCoreSessionToken } from "./access-policy.js";
import { installSignalShutdown } from "./signal-shutdown.js";
import { createServer, shutdownCore } from "./server.js";
import { updateCodexRuntime } from "./ai/providers/codex-runtime.js";

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
  // Registry checks and installs must not hold the Gateway health check hostage.
  // Existing sessions retain their launch command; new sessions see atomic updates.
  void updateCodexRuntime().catch((error) => console.warn(`[core] runtime update failed: ${String(error)}`));
  const access = await loadCoreSessionToken(port);
  if (access.file) console.log(`[core] session token file: ${access.file}`);
  const allowedOrigins = process.env.REMOTE_IDE_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  const server = await createServer(host, port, workspace, { access: { token: access.token, allowedOrigins } });
  installSignalShutdown(() => shutdownCore(server));
} catch (error) {
  console.error(`[core] failed to open workspace: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
