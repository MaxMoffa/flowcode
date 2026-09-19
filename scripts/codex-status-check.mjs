// Manual check: drives a REAL `codex` with the exact shipped logic from
// src/plugins/codexStatus.ts, through a real @xterm/headless terminal, and
// prints the parsed limits. Usage: node --experimental-strip-types scripts/codex-status-check.mjs [cwd]
import { spawn } from "node:child_process";
import xterm from "@xterm/headless";
import { CODEX_COLS, CODEX_ROWS, driveCodexStatus, parseCodexLimits, screenTextOf } from "../src/plugins/codexStatus.ts";

const cwd = process.argv[2] ?? process.env.HOME;
const term = new xterm.Terminal({ cols: CODEX_COLS, rows: CODEX_ROWS, scrollback: 200, allowProposedApi: true });
const bridge = spawn("python3", ["scripts/_ptybridge.py", String(CODEX_COLS), String(CODEX_ROWS), cwd], {
  stdio: ["pipe", "pipe", "inherit"],
});
bridge.stdout.on("data", (b) => term.write(b.toString("utf8")));

const t0 = Date.now();
const pty = {
  write: async (data) => { if (process.env.CODEX_CHECK_DEBUG) console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] write ${JSON.stringify(data)}`); bridge.stdin.write(data); },
  screen: () => screenTextOf(term),
};


try {
  const screen = await driveCodexStatus(pty);
  const limits = parseCodexLimits(screen);
  console.log(`--- cwd=${cwd}  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  console.log(screen.split("\n").filter((l) => /% left|Account:|Session:/.test(l)).join("\n") || "(no status rows on screen)");
  console.log("PARSED:", JSON.stringify(limits, null, 2));
  process.exitCode = limits.length ? 0 : 1;
} catch (e) {
  console.log("THREW:", String(e));
  process.exitCode = 1;
} finally {
  bridge.kill("SIGKILL");
}
