// DEV ONLY: sample terminal output for the mock (answers `open` with a snapshot).
import { emit } from "@tauri-apps/api/event";

const Y = "\x1b[33m";
const G = "\x1b[32m";
const D = "\x1b[90m";
const R = "\x1b[0m";
const SAMPLE = [
  `\x1b[91m●${R} Ho aggiornato ${Y}Reconnect.tsx${R}.`,
  `${D}  ⎿  +42 −7${R}`,
  ``,
  `\x1b[91m●${R} Ora eseguo la build per verificare.`,
  ``,
  `${Y}╭─ Posso eseguire npm run build? ─╮${R}`,
  `${Y}│${R} ❯ 1. Sì                         ${Y}│${R}`,
  `${Y}│${R} ${D}  2. Sì, non chiedere più${R}       ${Y}│${R}`,
  `${Y}│${R} ${D}  3. No${R}                          ${Y}│${R}`,
  `${Y}╰─────────────────────────────────╯${R}`,
  `${G}>${R} `,
].join("\r\n");

const NOTES = Array.from({ length: 60 }, (_, i) => `${i + 1}. nota di esempio numero ${i + 1}`).join("\n") + "\n";

/** A small fake tree, the same for every terminal. */
const FILES: Record<string, string> = {
  "package.json": `{\n  "name": "demo",\n  "version": "1.0.0",\n  "scripts": { "dev": "vite", "build": "tsc && vite build" },\n  "dependencies": { "react": "^18.3.1" }\n}\n`,
  "README.md": "# Demo\n\nUn progetto di esempio per il mock.\nServe a provare l'esplora file.\n",
  "notes.txt": NOTES,
  "src/App.tsx": "export function App() {\n  return <main>Ciao</main>;\n}\n",
  "src/ui.css": "body {\n  margin: 0;\n  font-family: sans-serif;\n}\n",
  "src/app/main.ts": 'import { App } from "../App";\n\nconsole.log(App);\n',
  "docs/README.md": "# Documentazione\n\nNiente di che.\n",
};
const DIRS = new Set(["", "src", "src/app", "docs"]);

function listing(path: string) {
  const prefix = path ? path + "/" : "";
  const seen = new Map<string, { name: string; dir: boolean; size?: number }>();
  for (const [file, text] of Object.entries(FILES)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...more] = file.slice(prefix.length).split("/");
    seen.set(name, more.length ? { name, dir: true } : { name, dir: false, size: text.length });
  }
  return [...seen.values()];
}

export function termMock(cmd: string, args: unknown): null {
  const msg = (args as { msg?: { t?: string; ptyId?: string; cols?: number; rows?: number; path?: string } } | undefined)?.msg;
  if (cmd === "send" && msg?.t === "open" && msg.ptyId) {
    const { ptyId, cols = 80, rows = 24 } = msg;
    setTimeout(() => void emit("remote://msg", { t: "snapshot", ptyId, cols, rows, data: SAMPLE }), 50);
  }
  if (cmd === "send" && msg?.ptyId && (msg.t === "ls" || msg.t === "read")) {
    const { ptyId, path = "" } = msg;
    const reply =
      msg.t === "ls"
        ? DIRS.has(path)
          ? { t: "ls", ptyId, path, entries: listing(path) }
          : null
        : path in FILES
          ? { t: "file", ptyId, path, text: FILES[path], truncated: false }
          : null;
    setTimeout(() => void emit("remote://msg", reply ?? { t: "error", ptyId, message: "not found", fatal: false }), 80);
  }
  return null;
}
