/** Codex CLI's `/status` screen: driving it and reading the numbers back.
 *
 * Kept free of any Tauri import on purpose - everything here talks to an
 * abstract pty (write keystrokes, read back the rendered screen), so the exact
 * code the app ships can also be driven against a real `codex` process from a
 * plain Node script (see scripts/codex-status-check.mjs). The Tauri wiring -
 * pty_spawn / pty_write / pty_kill plus an @xterm/headless terminal - lives in
 * usage.ts. */

export const CODEX_COLS = 120;
export const CODEX_ROWS = 45;

/** A live terminal session: keystrokes in, rendered screen out. */
export interface CodexPty {
  write(data: string): Promise<void>;
  /** The screen as text, one line per row (blank rows as empty strings). */
  screen(): string;
}

/** Minimal structural view of an @xterm/headless Terminal - typed structurally
 * rather than imported so this module stays dependency-free. */
export interface ScreenSource {
  buffer: { active: { length: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } };
}

export function screenTextOf(term: ScreenSource): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const COMPOSER_RE = /Ask Codex to do anything/i;
const TRUST_RE = /trust the contents of this directory/i;
const LOGGED_OUT_RE = /sign in with chatgpt|not (?:signed|logged) in|codex login/i;
/** Codex's own "Update available · 1. Update now · 2. Skip ..." startup
 * prompt. The probe launches codex with `check_for_update_on_startup=false`
 * so it normally never shows up - this is the backstop for a version that
 * ignores that setting. */
const UPDATE_RE = /update available/i;
/** Codex refusing to start its shared background server because the host's
 * Windows Job Object forbids breakaway ("host Job Object prevents daemon
 * detachment ... rerun the same command with --no-daemon"). */
const NO_DAEMON_RE = /rerun the same command with --no-daemon|prevents daemon detachment/i;
/** The distinctive shape of a `/status` limit row, wherever it sits on the
 * line - the row is drawn inside a box, so it has `│` borders around it. */
const LIMIT_READY_RE = /%\s*left\s*\(resets/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

export function screenTail(screen: string, lines = 4): string {
  return screen.trim().split("\n").filter(Boolean).slice(-lines).join(" · ");
}

/** A probe that gave up before reaching the numbers - carries the full
 * screen it was looking at, for the popover's "copy debug info" button. */
export class CodexStatusError extends Error {
  readonly screen: string;
  constructor(message: string, screen: string) {
    super(message);
    this.screen = screen;
  }
}

/** Diagnostic text for the popover when no limit row could be parsed. The
 * `/status` box is drawn ABOVE the composer, so a plain tail of the screen
 * shows the composer's own footer even when the box rendered perfectly - which
 * reads as "codex never answered" and hides a mere format change. So: show the
 * limit-ish rows when there are any, and only otherwise fall back to the tail. */
export function codexDiagnostic(screen: string): string {
  const rows = screen
    .split("\n")
    .map((l) => l.replace(/[│|]/g, " ").trim())
    .filter((l) => LIMIT_READY_RE.test(l) || /%\s*left/i.test(l));
  return rows.length ? rows.join(" · ") : screenTail(screen);
}

/** Launch codex in the session (`launch` is the command line to type -
 * `codex` plus whatever flags the host needs), get past the startup prompts,
 * run `/status` and return the screen that holds the answer. */
export async function driveCodexStatus(pty: CodexPty, launch = "codex"): Promise<string> {
  // `\r`, not `\n`: that's what a real Enter keypress sends (see
  // Terminal.tsx's own runCommand), and what actually submits a line on
  // Windows' ConPTY/cmd.exe - a bare `\n` just sits there unsubmitted,
  // which used to make this whole flow time out on Windows waiting for a
  // composer that never appears, well before ever getting to /status.
  await pty.write(`${launch}\r`);

  // Before anything else, get past whatever codex shows instead of its UI:
  // the update prompt (answered "skip") or the "can't start the background
  // server" error (codex is back at the shell prompt - rerun it the way the
  // error asks). Both are bounded, so leftover text in the scrollback can't
  // make them fire forever.
  let retriedNoDaemon = /--no-daemon/.test(launch);
  let updateSkips = 0;
  const appeared = await waitUntil(() => {
    const screen = pty.screen();
    if (COMPOSER_RE.test(screen) || TRUST_RE.test(screen)) return true;
    if (!retriedNoDaemon && NO_DAEMON_RE.test(screen)) {
      retriedNoDaemon = true;
      void pty.write(`${launch} --no-daemon\r`);
    } else if (updateSkips < 3 && UPDATE_RE.test(screen)) {
      updateSkips++;
      void pty.write("\x1b"); // "esc skip"
    }
    return false;
  }, 30000, 400);
  if (!appeared) {
    const screen = pty.screen();
    throw new CodexStatusError(screenTail(screen, 6) || "codex non ha risposto.", screen);
  }
  if (LOGGED_OUT_RE.test(pty.screen())) throw new CodexStatusError("codex login", pty.screen());

  // The "Do you trust the contents of this directory?" prompt is NOT always
  // the first thing drawn: codex paints the composer first (with "model:
  // loading") and only then swaps in the trust dialog. Treating the composer's
  // first appearance as "ready" therefore races - the "/status" keystrokes get
  // swallowed by the still-to-come dialog's list selector and the Enter just
  // answers the dialog, leaving an empty composer and no status box. So keep
  // answering the dialog for as long as it shows up, and require the composer
  // to stay dialog-free for a settle window before typing anything into it.
  const readyBy = Date.now() + 25000;
  let settled = false;
  while (Date.now() < readyBy) {
    if (TRUST_RE.test(pty.screen())) {
      await pty.write("\r"); // "1. Yes, continue" is the default selection.
      await waitUntil(() => !TRUST_RE.test(pty.screen()), 8000);
      continue;
    }
    if (!COMPOSER_RE.test(pty.screen())) {
      await sleep(150);
      continue;
    }
    await sleep(700);
    if (COMPOSER_RE.test(pty.screen()) && !TRUST_RE.test(pty.screen())) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    const screen = pty.screen();
    throw new CodexStatusError(screenTail(screen, 6) || "codex non è arrivato al prompt.", screen);
  }

  const hasLimits = () => LIMIT_READY_RE.test(pty.screen());

  for (let attempt = 0; attempt < 3; attempt++) {
    // Ctrl+U (kill-line) first: a previous attempt may have left "/status"
    // sitting unsubmitted in the composer, and retyping over it would produce
    // "/status/status", which matches no command.
    await pty.write("\x15");
    await pty.write("/status");
    // Wait for the keystrokes to actually show up before pressing Enter -
    // typing and submitting in the same breath can land while the composer's
    // slash-command popup is still opening.
    await waitUntil(() => /\/status/.test(pty.screen()), 2000);
    await sleep(250);
    await pty.write("\r");
    if (await waitUntil(hasLimits, 6000)) return pty.screen();
    // If the popup was open, that Enter only accepted the highlighted
    // suggestion into the composer; a second one actually submits it.
    await pty.write("\r");
    if (await waitUntil(hasLimits, 4000)) return pty.screen();
  }
  return pty.screen();
}

/** A rendered `/status` limit row, e.g.
 *   `│  5h limit:      [████░░░░] 42% left (resets 07:32)              │`
 * Deliberately unanchored: the row is drawn inside a bordered box, so the line
 * begins and ends with box-drawing characters and padding. The label is left
 * open (rather than hardcoded to "5h limit"/"Weekly limit") - the bar and the
 * "% left (resets ...)" shape around it are the distinctive signal. */
export const CODEX_LIMIT_RE = /([0-9A-Za-z][A-Za-z0-9 ()./-]*?):\s*\[[^\]\n]*\]\s*(\d{1,3})%\s*left\s*\(resets\s+([^)]+)\)/i;

export interface CodexLimit {
  label: string;
  /** Share of the window already consumed, 0-1. */
  percent: number;
  resets: string;
}

function codexLimitLabel(raw: string): string {
  if (/5h|5 ?hour/i.test(raw)) return "Sessione (5 ore)";
  if (/week/i.test(raw)) return "Settimana";
  return raw.trim();
}

export function parseCodexLimits(screen: string): CodexLimit[] {
  return screen
    .split("\n")
    .map((line) => line.match(CODEX_LIMIT_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, rawLabel, leftPct, resets]) => ({
      label: codexLimitLabel(rawLabel),
      percent: (100 - Number(leftPct)) / 100,
      resets: resets.trim(),
    }))
    // "5h limit" (the rolling session window) first: it's the one that moves
    // while you work, so it leads the popover's list. (The shortcut-bar mini
    // bar picks by pressure, not by order - see PluginUsageButton.)
    .sort((a, b) => (a.label.includes("5 ore") ? -1 : b.label.includes("5 ore") ? 1 : 0));
}
