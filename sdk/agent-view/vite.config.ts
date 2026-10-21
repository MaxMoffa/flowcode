import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Where plugins that ship a copy of the SDK keep it, besides docs/agent-views/sdk. */
const COPIES = [path("../../docs/agent-views/timeline")];

// Bundles index.ts and the chat model it reuses into one dependency-free file,
// as an ES module and as a classic script (global `FlowcodeView`), then copies
// the classic script into the plugins that ship it. A view loads that one: its
// page has an opaque origin, so a `<script type="module">` from the view's
// scheme would be a cross-origin fetch.
export default defineConfig({
  publicDir: false,
  build: {
    lib: { entry: path("./index.ts"), name: "FlowcodeView", formats: ["es", "iife"], fileName: (format) => (format === "es" ? "flowcode-view.js" : "flowcode-view.iife.js") },
    outDir: path("../../docs/agent-views/sdk"),
    emptyOutDir: false,
    minify: false,
    target: "es2020",
  },
  plugins: [
    {
      name: "copy-view-sdk",
      closeBundle() {
        const out = path("../../docs/agent-views/sdk");
        for (const dir of COPIES) {
          mkdirSync(dir, { recursive: true });
          copyFileSync(`${out}/flowcode-view.iife.js`, `${dir}/flowcode-view.iife.js`);
        }
        copyFileSync(path("./flowcode-view.d.ts"), `${out}/flowcode-view.d.ts`);
      },
    },
  ],
});
