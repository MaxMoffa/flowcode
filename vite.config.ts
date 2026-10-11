import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  resolve: {
    alias: [
      // @flowkit-io/react's style.css unconditionally @imports this for its
      // "location" step type, which Flowcode's welcome flow doesn't use -
      // maplibre-gl itself is an optional peer dependency we don't install,
      // so without this alias the CSS import 404s. See src/welcome/empty.css.
      {
        find: "maplibre-gl/dist/maplibre-gl.css",
        replacement: fileURLToPath(new URL("./src/welcome/empty.css", import.meta.url)),
      },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`, and `design` - a stray
      // .html there otherwise triggers a full page reload, killing every
      // open terminal session
      ignored: ["**/src-tauri/**", "**/design/**"],
    },
  },
}));
