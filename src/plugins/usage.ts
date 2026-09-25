import { invoke } from "@tauri-apps/api/core";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { getConfiguredShell } from "../terminal/TerminalSettingsContext";
import { killPty, spawnPty, writePty } from "../terminal/ptyClient";
import pkg from "../../package.json";
import { t } from "../i18n";
import { withCodexLaunchFlags } from "./codexLaunch";
import {
  CODEX_COLS,
  CODEX_ROWS,
  CodexStatusError,
  codexDiagnostic,
  driveCodexStatus,
  parseCodexLimits,
  screenTextOf,
} from "./codexStatus";

export interface UsageMetric {
  /** What the row is - its label is translated at render time (see
   * `metricText`), so a cached result follows a language change. `other`
   * keeps the CLI's own wording in `label`. */
  kind: "session" | "week" | "other" | "unavailable" | "loggedOut";
  label?: string;
  /** When the window resets, as the CLI worded it. */
  resets?: string;
  /** loggedOut: the command that signs in. */
  command?: string;
  /** 0-1 fill level for a bar/ring - omitted (never guessed) when the CLI
   * doesn't expose a number for this metric outside an interactive session. */
  percent?: number;
}

export interface UsageInfo {
  fetchedAt: number;
  ok: boolean;
  metrics: UsageMetric[];
  /** When `ok` is false: what went wrong, as plain text for the popover's
   * "copy debug info" button - never rendered in the popover itself. */
  debug?: string;
}

/** Label and detail line of a metric, in the current language. */
export function metricText(m: UsageMetric): { label: string; detail?: string } {
  switch (m.kind) {
    case "unavailable":
      return { label: t("usage.unavailable") };
    case "loggedOut":
      return { label: t("usage.notLinked"), detail: t("usage.loginHint", { command: m.command ?? "" }) };
    default:
      return {
        label: m.kind === "session" ? t("usage.session") : m.kind === "week" ? t("usage.week") : (m.label ?? ""),
        detail: m.resets ? t("usage.resets", { when: m.resets }) : undefined,
      };
  }
}

/** A failed probe: a plain "Unavailable" in the popover, with every
 * detail (error, raw CLI output) moved into `debug`. */
function unavailable(cli: string, sections: Record<string, string | undefined>): UsageInfo {
  const lines = [
    `Flowcode v${pkg.version} · ${navigator.userAgent}`,
    `${cli} · ${new Date().toISOString()}`,
    ...Object.entries(sections)
      .filter(([, text]) => text?.trim())
      .map(([title, text]) => `\n--- ${title} ---\n${text!.replace(/\s+$/, "")}`),
  ];
  return {
    fetchedAt: Date.now(),
    ok: false,
    metrics: [{ kind: "unavailable" }],
    debug: lines.join("\n"),
  };
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

    // No update check: codex's "Update available · 1. Update now ..." prompt
    // would sit in front of the composer this probe waits for. The user
    // still gets it in their own sessions, where it can be answered.
    const launch = await withCodexLaunchFlags("codex -c check_for_update_on_startup=false");
    return await driveCodexStatus(
      {
        write: (data) => writePty(ptyId, data),
        screen: () => screenTextOf(term),
      },
      launch,
    );
  } finally {
    done = true;
    if (id) killPty(id);
    term.dispose();
  }
}

function errorSections(e: unknown): Record<string, string | undefined> {
  return {
    Error: e instanceof Error ? e.message : String(e),
    Screen: e instanceof CodexStatusError ? e.screen.trim() : undefined,
  };
}

async function fetchCodexUsage(): Promise<UsageInfo> {
  let screen: string;
  try {
    screen = await readCodexStatusScreen();
  } catch (e) {
    const loggedOut = /sign.?in|log.?in/i.test(String(e));
    if (loggedOut) {
      return {
        fetchedAt: Date.now(),
        ok: false,
        metrics: [{ kind: "loggedOut", command: "codex login" }],
      };
    }
    // A cold ConPTY session on Windows occasionally comes up with its
    // output stalled for several seconds (a real OS-level quirk, not
    // something retrying the same session can fix - see warmup_conpty in
    // pty.rs) - a session that never got anywhere near a real codex prompt
    // is worth one fresh attempt (a brand new pty, not just resending
    // keystrokes into the stuck one) before actually giving up. A genuine
    // "please log in" is a real signal, not a fluke - no point retrying
    // that.
    try {
      screen = await readCodexStatusScreen();
    } catch (e2) {
      return unavailable("Codex CLI", {
        "First attempt": errorSections(e).Error,
        ...errorSections(e2),
      });
    }
  }

  const metrics: UsageMetric[] = parseCodexLimits(screen).map((limit) => ({
    kind: limit.kind,
    label: limit.label,
    percent: limit.percent,
    resets: limit.resets,
  }));

  if (metrics.length === 0) {
    // The whole screen goes into the debug info, so a format change in a
    // future Codex version (a relabeled row, different wording around the
    // percentage) is diagnosable instead of an opaque "no data".
    return unavailable("Codex CLI", {
      Error: "No usage row recognized in /status.",
      Diagnostics: codexDiagnostic(screen),
      Screen: screen.trim(),
    });
  }
  return { fetchedAt: Date.now(), ok: true, metrics };
}

/** Matches a line like "Current session: 52% used · resets Sep 19, 12am
 * (Europe/Rome)" from `claude -p "/usage"`'s plain-text output - "/usage" is
 * a client-side slash command (no model call, no cost), the same one
 * available inside an interactive session, just run through -p to get its
 * text back instead of rendering it in a TUI. */
const USAGE_LINE_RE = /^(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?\s*$/;

function claudeUsageKind(raw: string): UsageMetric["kind"] {
  if (/session/i.test(raw)) return "session";
  if (/week/i.test(raw)) return "week";
  return "other";
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
    if (/not.{0,3}logged.?in|unauthoriz|\/login\b|auth(?:entication)? (?:failed|required|error)/i.test(message)) {
      return {
        fetchedAt: Date.now(),
        ok: false,
        metrics: [{ kind: "loggedOut", command: "claude auth login" }],
      };
    }
    return unavailable("Claude Code", { Error: message });
  }

  // "Current session" (the 5-hour rolling window) first: it's the one that
  // moves while you work, so it leads the popover's list. (The shortcut-bar
  // mini bar picks by pressure, not by order - see PluginUsageButton.)
  const metrics: UsageMetric[] = out
    .split("\n")
    .map((line) => line.match(USAGE_LINE_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, rawLabel, pct, resets]): UsageMetric => ({
      kind: claudeUsageKind(rawLabel),
      label: rawLabel.trim(),
      percent: Number(pct) / 100,
      resets: resets?.trim(),
    }))
    .sort((a, b) => (a.kind === "session" ? -1 : b.kind === "session" ? 1 : 0));

  if (metrics.length === 0) {
    return unavailable("Claude Code", {
      Error: "No usage row recognized in the output of claude -p /usage.",
      Output: out,
    });
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
