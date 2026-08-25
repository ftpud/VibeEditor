await import("./fix-node-pty.mjs");

if (process.env.VIBE_SKIP_JDTLS === "1") {
  console.log("[postinstall] Skipping JDT LS installation on this desktop-only installation.");
  process.exit(0);
}

try {
  await import("./install-jdtls.mjs");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[postinstall] JDT LS was not installed: ${message}`);
  console.warn("[postinstall] This is optional on desktop-only machines. Run `npm run install:jdtls` on the backend machine to retry.");
}
