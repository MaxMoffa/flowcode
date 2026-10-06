import { invoke } from "@tauri-apps/api/core";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { getConfiguredShell } from "../terminal/TerminalSettingsContext";
import { killPty, spawnPty, writePty } from "../terminal/ptyClient";
import pkg from "../../package.json";
import { t } from "../i18n";
import { withCodexLaunchFlags } from "./codexLaunch";
import { unrecorded } from "../terminal/shellDialect";
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
  kind:
    | "session"
    | "week"
    | "other"
    | "unavailable"
    | "loggedOut"
    | "spend"
    | "model"
    | "noApiKey"
    | "billing"
    | "unpriced";
  label?: string;
  /** When the window resets, as the CLI worded it. */
  resets?: string;
  /** loggedOut / noApiKey: the command that signs in. */
  command?: string;
  /** spend: the period summed up, and what was spent in it - cost in USD. */
  period?: "today" | "week" | "month";
  cost?: number;
  tokens?: number;
  sessions?: number;
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

/** "$0.42" - cents for anything under $100, "<$0.01" for a spend too small
 * to show as cents but not nothing. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
}

/** "1.2M" / "850K" / "920" tokens. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Label, detail line and right-hand value of a metric, in the current
 * language - `value` is a figure that isn't a percentage (a spend, a model
 * name); a percentage is drawn from `percent` directly. */
export function metricText(m: UsageMetric): { label: string; detail?: string; value?: string } {
  switch (m.kind) {
    case "unavailable":
      return { label: t("usage.unavailable") };
    case "loggedOut":
      return { label: t("usage.notLinked"), detail: t("usage.loginHint", { command: m.command ?? "" }) };
    case "noApiKey":
      return { label: t("usage.noApiKey"), detail: t("usage.apiKeyHint", { command: m.command ?? "" }) };
    case "spend":
      return {
        label: t(`usage.spend.${m.period ?? "today"}`),
        value: formatCost(m.cost ?? 0),
        detail: t("usage.spend.detail", { tokens: formatTokens(m.tokens ?? 0), sessions: String(m.sessions ?? 0) }),
      };
    case "model":
      return { label: t("usage.model"), value: m.label };
    case "billing":
      return { label: t("usage.billing.api"), detail: t("usage.billing.estimate") };
    case "unpriced":
      return { label: t("usage.unpriced"), detail: m.label };
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
    // Typed with a leading space so it stays out of the shell's history.
    const launch = unrecorded(await withCodexLaunchFlags("codex -c check_for_update_on_startup=false"));
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
  // On an API key there's no plan limit for `/status` to show - and no
  // reason to start a hidden Codex session: the spend is read off disk.
  if ((await billingMode("codex")) === "api") return fetchCliSpend("codex", "Codex CLI");
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
  if ((await billingMode("claude")) === "api") return fetchCliSpend("claude", "Claude Code");
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

/** How a CLI is paid for - see `cli_billing_mode` in src-tauri/src/plugins.rs.
 * Asked on every refresh, not remembered: switching a CLI from a plan to an
 * API key (or back) shows in the popup on its next refresh. */
type BillingMode = "subscription" | "api" | "unknown";

async function billingMode(cli: "claude" | "codex"): Promise<BillingMode> {
  try {
    return await invoke<BillingMode>("cli_billing_mode", { cli });
  } catch {
    return "unknown";
  }
}

/** One period of spend, as the backend sums it (src-tauri/src/spend.rs). */
interface Spend {
  cost: number;
  tokens: number;
  sessions: number;
}

/** What `cli_spend` (src-tauri/src/spend.rs) answers. */
interface CliSpend {
  today: Spend;
  week: Spend;
  month: Spend;
  lastModel: string | null;
  unpricedModels: string[];
}

/** What `vibe_usage_stats` (src-tauri/src/vibe.rs) answers. */
interface VibeUsage {
  hasApiKey: boolean;
  today: Spend;
  week: Spend;
  month: Spend;
  lastModel: string | null;
}

/** Today's local midnight (ms) - the backend has no timezone of its own. */
function todayStart(): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/** The today / 7 days / 30 days rows of a pay-per-use CLI's popup. */
function spendMetrics(usage: { today: Spend; week: Spend; month: Spend }): UsageMetric[] {
  const row = (period: "today" | "week" | "month", s: Spend): UsageMetric => ({
    kind: "spend",
    period,
    cost: s.cost,
    tokens: s.tokens,
    sessions: s.sessions,
  });
  return [row("today", usage.today), row("week", usage.week), row("month", usage.month)];
}

/** "claude-opus-4-6" / "claude-sonnet-4-5-20250929" -> "Claude Opus 4.6" /
 * "Claude Sonnet 4.5"; "gpt-5.1-codex-max" -> "GPT-5.1-Codex-Max". Anything
 * else is shown as the CLI named it. */
function modelDisplayName(id: string): string {
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) {
    const [, family, major, minor] = claude;
    return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  }
  if (/^gpt-/i.test(id)) {
    return id
      .split("-")
      .map((part, i) => (i === 0 ? "GPT" : part[0] ? part[0].toUpperCase() + part.slice(1) : part))
      .join("-");
  }
  return id;
}

/** Claude Code or Codex on an API key: billed per token, so - like Mistral
 * Vibe - what it cost instead of a usage limit. Summed from the CLI's own
 * session transcripts on this machine and priced at list prices (see
 * spend.rs), which the popup says: the vendor's console stays the
 * authority for the bill. */
async function fetchCliSpend(cli: "claude" | "codex", name: string): Promise<UsageInfo> {
  let usage: CliSpend;
  try {
    usage = await invoke<CliSpend>("cli_spend", { cli, todayStart: todayStart() });
  } catch (e) {
    return unavailable(name, { Error: String(e) });
  }
  const metrics: UsageMetric[] = [{ kind: "billing" }, ...spendMetrics(usage)];
  if (usage.lastModel) metrics.push({ kind: "model", label: modelDisplayName(usage.lastModel) });
  if (usage.unpricedModels.length > 0) metrics.push({ kind: "unpriced", label: usage.unpricedModels.join(", ") });
  return { fetchedAt: Date.now(), ok: true, metrics };
}

/** Vibe's own aliases for Mistral's models, as people know them. */
const VIBE_MODEL_NAMES: Record<string, string> = {
  "mistral-large-4": "Mistral Large 4",
  "mistral-medium-3.5": "Mistral Medium 3.5",
  local: "Devstral (local)",
};

/** Mistral Vibe's spend: billed per token on a Mistral API key, it has no
 * usage limit to show a fill level for - instead what it cost today and over
 * the last 7 / 30 days, summed from the sessions Vibe saved on disk (no
 * process started, no network call). Mistral's own console stays the
 * authority for the bill: a session run on another machine isn't here. */
async function fetchVibeUsage(): Promise<UsageInfo> {
  let usage: VibeUsage;
  try {
    usage = await invoke<VibeUsage>("vibe_usage_stats", { todayStart: todayStart() });
  } catch (e) {
    return unavailable("Mistral Vibe", { Error: String(e) });
  }
  const metrics = spendMetrics(usage);
  if (usage.lastModel) {
    metrics.push({ kind: "model", label: VIBE_MODEL_NAMES[usage.lastModel] ?? usage.lastModel });
  }
  if (!usage.hasApiKey) metrics.unshift({ kind: "noApiKey", command: "vibe --setup" });
  return { fetchedAt: Date.now(), ok: true, metrics };
}

const FETCHERS: Record<string, UsageFetcher> = {
  "codex-cli": fetchCodexUsage,
  "claude-code": fetchClaudeUsage,
  "mistral-vibe": fetchVibeUsage,
};

export function usageFetcherFor(id: string): UsageFetcher | undefined {
  return FETCHERS[id];
}
