import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Vite Desktop sends an HTTP Origin even inside Electron. Allow only the
// development server's exact local origins; the session token is still required.
const origins = new Set([
  ...(process.env.REMOTE_IDE_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), "watch", "src/index.ts", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../packages/core/", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, REMOTE_IDE_ALLOWED_ORIGINS: [...origins].join(",") },
});
child.on("error", (error) => { console.error(`[core] failed to start: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
