import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  base: "./",
  server: { port: 5174, strictPort: true },
  build: { outDir: "../../dist-renderer", emptyOutDir: true }
});
