import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageRoot = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  const helper = path.join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
