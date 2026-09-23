import { invoke } from "@tauri-apps/api/core";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { getConfiguredShell } from "../terminal/TerminalSettingsContext";
import { killPty, spawnPty, writePty } from "../terminal/ptyClient";
import {
  CODEX_COLS,
  CODEX_ROWS,
  codexDiagnostic,
  driveCodexStatus,
  parseCodexLimits,
  screenTextOf,
} from "./codexStatus";

export interface UsageMetric {
  label: string;
  detail?: string;
  /** 0-1 fill level for a bar/ring - omitted (never guessed) when the CLI
   * doesn't expose a number for this metric outside an interactive session. */
  percent?: number;
}

export interface UsageInfo {
  fetchedAt: number;
  ok: boolean;
  metrics: UsageMetric[];
}

type UsageFetcher = () => Promise<UsageInfo>;

/** Codex CLI's numeric rate-limit data only exists behind the interactive
 * TUI's `/status` slash command - `codex exec` doesn't expose it (a slash
 * command passed to `exec` goes to the model as literal prompt text, not to
 * the client-side status view), and there's no plain flag for it. So this
 * drives a throwaway, invisible `codex` session just long enough to run
 * `/status` and read the rendered screen back, using `@xterm/headless`
 * (no DOM) to parse the pty stream exactly like a visible terminal tab
 * would. Killed the moment the numbers are read - never left running. */
async function readCodexStatusScreen(): Promise<string> {
  // A little scrollback, not none: the `/status` box is tall, and in a session
  // that already printed something (shell banner, codex tips) its first rows
  // can scroll above the viewport - buffer.active spans the scrollback too,
  // so screenTextOf still sees them.
  const term = new HeadlessTerminal({ cols: CODEX_COLS, rows: CODEX_ROWS, scrollback: 200, allowProposedApi: true });
  let id: string | null = null;
  let done = false;
  // Same wiring as a visible tab (Terminal.tsx): the shell's own startup
  // queries (cmd.exe's first output is a DSR `ESC[6n`) must be answered or
  // the session stalls. Replies produced before the id is known are queued.
  const pendingReplies: string[] = [];
  term.onData((data) => {
    if (id) writePty(id, data);
    else pendingReplies.push(data);
  });
  try {
    id = await spawnPty({
      cols: CODEX_COLS,
      rows: CODEX_ROWS,
      shell: getConfiguredShell(),
      onOutput: (data) => {
        if (!done) term.write(data);
      },
    });
    const ptyId = id;
    for (const data of pendingReplies.splice(0)) writePty(ptyId, data);

    return await driveCodexStatus({
      write: (data) => writePty(ptyId, data),
      screen: () => screenTextOf(term),
    });
  } finally {
    done = true;
    if (id) killPty(id);
    term.dispose();
  }
}

async function fetchCodexUsage(): Promise<UsageInfo> {
  let screen: string;
  try {
    screen = await readCodexStatusScreen();
  } catch (e) {
    const message = String(e);
    const loggedOut = /sign.?in|log.?in/i.test(message);
    // A cold ConPTY session on Windows occasionally comes up with its
    // output stalled for several seconds (a real OS-level quirk, not
    // something retrying the same session can fix - see warmup_conpty in
    // pty.rs) - a session that never got anywhere near a real codex prompt
    // is worth one fresh attempt (a brand new pty, not just resending
    // keystrokes into the stuck one) before actually giving up. A genuine
    // "please log in" is a real signal, not a fluke - no point retrying
    // that.
    if (!loggedOut) {
      try {
        screen = await readCodexStatusScreen();
      } catch (e2) {
        return {
          fetchedAt: Date.now(),
          ok: false,
          metrics: [{ label: "Non disponibile", detail: String(e2) }],
        };
      }
    } else {
      return {
        fetchedAt: Date.now(),
        ok: false,
        metrics: [{ label: "Non collegato", detail: 'Esegui "codex login" nel terminale per collegare un account.' }],
      };
    }
  }

  const metrics: UsageMetric[] = parseCodexLimits(screen).map((limit) => ({
    label: limit.label,
    percent: limit.percent,
    detail: `Si azzera ${limit.resets}`,
  }));

  if (metrics.length === 0) {
    // Include a tail of whatever the screen actually showed, so a format
    // change in a future Codex version (a relabeled row, different wording
    // around the percentage) is diagnosable from the popover itself instead
    // of showing an opaque "no data" with no way to tell why.
    const tail = codexDiagnostic(screen);
    return {
      fetchedAt: Date.now(),
      ok: false,
      metrics: [{ label: "Non disponibile", detail: tail || "Nessun dato di utilizzo in /status." }],
    };
  }
  return { fetchedAt: Date.now(), ok: true, metrics };
}

/** Matches a line like "Current session: 52% used · resets Sep 19, 12am
 * (Europe/Rome)" from `claude -p "/usage"`'s plain-text output - "/usage" is
 * a client-side slash command (no model call, no cost), the same one
 * available inside an interactive session, just run through -p to get its
 * text back instead of rendering it in a TUI. */
const USAGE_LINE_RE = /^(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?\s*$/;

function claudeUsageLabel(raw: string): string {
  if (/session/i.test(raw)) return "Sessione (5 ore)";
  if (/week/i.test(raw)) return "Settimana";
  return raw.trim();
}

async function fetchClaudeUsage(): Promise<UsageInfo> {
  let out: string;
  try {
    // Dedicated command (not the generic `run_plugin_command`): it
    // tracks this probe's real pid on the Rust side so `list_claude_agents`
    // can exclude it - see `run_claude_usage_probe` in src-tauri/src/agents.rs.
    out = await invoke<string>("run_claude_usage_probe");
  } catch (e) {
    const message = String(e);
    return {
      fetchedAt: Date.now(),
      ok: false,
      metrics: [
        {
          label: /not.{0,3}logged.?in|unauthoriz|auth/i.test(message) ? "Non collegato" : "Non disponibile",
          detail: message,
        },
      ],
    };
  }

  // "Current session" (the 5-hour rolling window) first: it's the one that
  // moves while you work, so it leads the popover's list. (The shortcut-bar
  // mini bar picks by pressure, not by order - see PluginUsageButton.)
  const metrics: UsageMetric[] = out
    .split("\n")
    .map((line) => line.match(USAGE_LINE_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, rawLabel, pct, resets]) => ({
      label: claudeUsageLabel(rawLabel),
      percent: Number(pct) / 100,
      detail: resets ? `Si azzera ${resets.trim()}` : undefined,
    }))
    .sort((a, b) => (a.label.includes("5 ore") ? -1 : b.label.includes("5 ore") ? 1 : 0));

  if (metrics.length === 0) {
    return {
      fetchedAt: Date.now(),
      ok: false,
      metrics: [{ label: "Non disponibile", detail: out.slice(0, 200) || "Nessun dato di utilizzo nell'output." }],
    };
  }
  return { fetchedAt: Date.now(), ok: true, metrics };
}

const FETCHERS: Record<string, UsageFetcher> = {
  "codex-cli": fetchCodexUsage,
  "claude-code": fetchClaudeUsage,
};

export function usageFetcherFor(id: string): UsageFetcher | undefined {
  return FETCHERS[id];
}
