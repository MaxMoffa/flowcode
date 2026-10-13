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

export function termMock(cmd: string, args: unknown): null {
  const msg = (args as { msg?: { t?: string; ptyId?: string; cols?: number; rows?: number } } | undefined)?.msg;
  if (cmd === "send" && msg?.t === "open" && msg.ptyId) {
    const { ptyId, cols = 80, rows = 24 } = msg;
    setTimeout(() => void emit("remote://msg", { t: "snapshot", ptyId, cols, rows, data: SAMPLE }), 50);
  }
  return null;
}
