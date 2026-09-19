// Manual check: drives a REAL `codex` with the exact shipped logic from
// src/plugins/codexStatus.ts, through a real @xterm/headless terminal, and
// prints the parsed limits. Usage: node --experimental-strip-types scripts/codex-status-check.mjs [cwd]
import { spawn } from "node:child_process";
import xterm from "@xterm/headless";
import { CODEX_COLS, CODEX_ROWS, driveCodexStatus, parseCodexLimits, screenTextOf } from "../src/plugins/codexStatus.ts";

const cwd = process.argv[2] ?? process.env.HOME ?? process.env.USERPROFILE;
const term = new xterm.Terminal({ cols: CODEX_COLS, rows: CODEX_ROWS, scrollback: 200, allowProposedApi: true });
// scripts/_ptybridge.py needs POSIX-only modules (pty/fcntl/termios) and
// can't run on Windows - src-tauri/examples/ptybridge.rs is the same job
// through the app's own portable-pty backend instead.
const bridge =
  process.platform === "win32"
    ? spawn("cargo", ["run", "--quiet", "--example", "ptybridge", "--", String(CODEX_COLS), String(CODEX_ROWS), cwd], {
        cwd: "src-tauri",
        stdio: ["pipe", "pipe", "inherit"],
      })
    : spawn("python3", ["scripts/_ptybridge.py", String(CODEX_COLS), String(CODEX_ROWS), cwd], {
        stdio: ["pipe", "pipe", "inherit"],
      });
bridge.stdout.on("data", (b) => term.write(b.toString("utf8")));
// Without this, the shell's own automatic queries (Windows ConPTY's cmd.exe
// opens with a DSR cursor-position request, `ESC[6n`) never get answered,
// and cmd.exe hangs right there forever - this was the actual bug behind
// "codex non ha risposto" on Windows, not anything in driveCodexStatus
// itself. usage.ts's real headless terminal needs this same wiring (now
// fixed there too).
term.onData((data) => bridge.stdin.write(data));

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
