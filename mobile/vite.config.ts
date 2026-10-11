import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const root = fileURLToPath(new URL(".", import.meta.url));

// Run from the repo root (`npm run mobile:vite`): the app reuses the root
// node_modules, so the dev server may serve files from one level up.
export default defineConfig({
  root,
  plugins: [react()],
  clearScreen: false,
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
