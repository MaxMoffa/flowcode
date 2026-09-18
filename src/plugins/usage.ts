import { invoke } from "@tauri-apps/api/core";

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

/** Headless, strict (fails on non-zero exit) - unlike the plugin
 * "commandOutput" action, which is tolerant and merges stderr for display.
 * Structured parsing needs to know whether the command actually succeeded. */
async function runStdout(command: string): Promise<string> {
  return invoke<string>("run_plugin_command_stdout", { command });
}

/** Codex CLI (checked directly: `codex login status`, `codex doctor`, its
 * config/cache dirs) has no non-interactive way to report numeric
 * rate-limit/usage data today, unlike Claude Code's "/usage" below - so
 * `percent` stays undefined here on purpose rather than showing a made-up
 * number. If a future CLI version adds one, the popover/ring pick it up
 * automatically the moment this fetcher starts returning it. */
async function fetchCodexUsage(): Promise<UsageInfo> {
  try {
    const out = (await runStdout("codex login status")).trim();
    const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
    return {
      fetchedAt: Date.now(),
      ok: true,
      metrics: [
        {
          label: loggedIn ? out : "Non collegato",
          detail: loggedIn
            ? "Codex CLI non espone i limiti di utilizzo fuori da una sessione interattiva."
            : 'Esegui "codex login" nel terminale per collegare un account.',
        },
      ],
    };
  } catch (e) {
    return { fetchedAt: Date.now(), ok: false, metrics: [{ label: "Non disponibile", detail: String(e) }] };
  }
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
    out = await runStdout('claude -p "/usage"');
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

  // "Current session" (the 5-hour rolling window) first, so it's the metric
  // the shortcut-bar ring picks up - see PluginUsageButton.
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
