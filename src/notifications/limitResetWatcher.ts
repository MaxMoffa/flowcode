import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { readString, writeString } from "../lib/storage";
import type { UsageInfo } from "../plugins/usage";
import { onUsageFetched } from "../plugins/useUsageState";
import { getNotificationSettings } from "./notificationSettings";

/** Plugin id -> when its blocking limit lifts (ms). In storage, so a reset
 * still gets its notification after the app restarts - and every window
 * shares it (notify_once keeps that to a single notification). */
type Pending = Record<string, number>;

const KEY = "flowcode.limitResets";
const CHECK_MS = 30_000;
/** A reset that passed this long ago (the app was closed, the computer
 * asleep) isn't news anymore. */
const LATE_MS = 15 * 60_000;

const NAMES: Record<string, string> = { "claude-code": "Claude Code", "codex-cli": "Codex" };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = `(${MONTHS.join("|")})[a-z]*\\.?`;
/** "Sep 19" (Claude Code) / "20 Sep" (Codex). */
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\b`);
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})\\s+${MONTH}`);

/** When a reset worded by the CLI happens - Claude Code: "3pm (Europe/Rome)",
 * "Sep 19, 12am (Europe/Rome)"; Codex: "07:32", "07:32 on 20 Sep". Read as
 * local time; a bare time is its next occurrence. `null` when unreadable. */
export function parseResetTime(text: string, now = new Date()): number | null {
  // The time zone in parentheses is the user's own.
  let s = text.replace(/\([^)]*\)/g, " ").toLowerCase();
  let hours = 0;
  let minutes = 0;
  const time = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2] ?? 0);
    if (time[3]) hours = (hours % 12) + (time[3] === "pm" ? 12 : 0);
    if (hours > 23 || minutes > 59) return null;
    s = s.replace(time[0], " ");
  }
  const date = s.match(MONTH_DAY_RE) ?? s.match(DAY_MONTH_RE);
  if (date) {
    const [monthName, day] = /\d/.test(date[1]) ? [date[2], date[1]] : [date[1], date[2]];
    const at = new Date(now.getFullYear(), MONTHS.indexOf(monthName), Number(day), hours, minutes);
    // "Jan 2" read in late December is next year's.
    if (at.getTime() < now.getTime() - 180 * 86_400_000) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  if (!time) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function readPending(): Pending {
  try {
    const parsed: unknown = JSON.parse(readString(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Pending) : {};
  } catch {
    return {};
  }
}

function writePending(pending: Pending) {
  writeString(KEY, JSON.stringify(pending));
}

function notifyReset(pluginId: string, at: number) {
  if (!getNotificationSettings().limitReset) return;
  const agent = NAMES[pluginId] ?? pluginId;
  void invoke("notify_once", {
    key: `${pluginId}:${at}`,
    label: getCurrentWindow().label,
    title: agent,
    body: t("notifications.body.limitReset", { agent }),
  }).catch(() => {});
}

/** When the account is blocked: the latest reset among the limits it has
 * used up (a spent weekly limit outlasts the 5-hour one). */
function blockedUntil(usage: UsageInfo): number | null {
  const resets = usage.metrics
    .filter((m) => (m.kind === "session" || m.kind === "week") && (m.percent ?? 0) >= 1 && m.resets)
    .map((m) => parseResetTime(m.resets!))
    .filter((at): at is number => at !== null);
  return resets.length ? Math.max(...resets) : null;
}

function onUsage(pluginId: string, usage: UsageInfo) {
  if (!usage.ok || !NAMES[pluginId]) return;
  const pending = readPending();
  const until = blockedUntil(usage);
  if (until !== null) {
    if (pending[pluginId] === until) return;
    pending[pluginId] = until;
  } else if (pluginId in pending) {
    // Free again: right on time is the reset itself (the poll beat the
    // timer); well before it, the limit lifted some other way.
    if (pending[pluginId] <= Date.now() + 60_000) notifyReset(pluginId, pending[pluginId]);
    delete pending[pluginId];
  } else {
    return;
  }
  writePending(pending);
}

function check() {
  const pending = readPending();
  const now = Date.now();
  let changed = false;
  for (const [pluginId, at] of Object.entries(pending)) {
    if (now < at) continue;
    if (now - at < LATE_MS) notifyReset(pluginId, at);
    delete pending[pluginId];
    changed = true;
  }
  if (changed) writePending(pending);
}

/** Notifies when an account that hit its Claude Code / Codex usage limit can
 * work again. Rides on the usage the shortcut bar already fetches (see
 * useUsageState.ts) - nothing is probed just for this. A polled clock rather
 * than one timer per reset: a timer can oversleep a suspended computer. */
export function watchLimitResets(): () => void {
  const stopListening = onUsageFetched(onUsage);
  check();
  const timer = setInterval(check, CHECK_MS);
  return () => {
    stopListening();
    clearInterval(timer);
  };
}
