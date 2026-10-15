import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { CLI_INFO, cliOfPlugin } from "../agents/cliInfo";
import { readJson, writeJson } from "../lib/storage";
import type { UsageInfo } from "../plugins/usage";
import { onUsageFetched } from "../plugins/useUsageState";
import { getNotificationSettings } from "./notificationSettings";

/** Account -> when its blocking limit lifts (ms); see `pendingKey` for what
 * identifies an account. In storage, so a reset still gets its notification
 * after the app restarts - and every window shares it (notify_once keeps that
 * to a single notification). */
type Pending = Record<string, number>;

const KEY = "flowcode.limitResets";
const CHECK_MS = 30_000;
/** A reset that passed this long ago (the app was closed, the computer
 * asleep) isn't news anymore. */
const LATE_MS = 15 * 60_000;

/** The default account is the bare plugin id (what older versions stored);
 * an account profile's is `<plugin id>\u0000<profile id>`. */
function pendingKey(pluginId: string, profile?: string): string {
  return profile ? `${pluginId}\u0000${profile}` : pluginId;
}

function splitKey(key: string): [string, string | undefined] {
  const [pluginId, profile] = key.split("\u0000");
  return [pluginId, profile];
}

/** A profile's display name, its id when it can't be read any more. */
async function profileName(profile: string): Promise<string> {
  try {
    const state = await invoke<{ profiles: { id: string; name: string }[] }>("profiles_list");
    return state.profiles.find((p) => p.id === profile)?.name ?? profile;
  } catch {
    return profile;
  }
}

/** The CLIs whose usage limit is watched (Vibe is pay-per-use: no limit). */
function watchedName(pluginId: string): string | undefined {
  const cli = cliOfPlugin(pluginId);
  return cli === "claude" || cli === "codex" ? CLI_INFO[cli].name : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = `(${MONTHS.join("|")})[a-z]*\\.?`;
/** "Sep 19" (Claude Code) / "20 Sep" / "Sep 20th, 2026" (Codex). */
const ORDINAL = "(?:st|nd|rd|th)?";
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}\\b`);
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+${MONTH}`);

/** When a reset worded by the CLI happens - Claude Code: "3pm (Europe/Rome)",
 * "Sep 19, 12am (Europe/Rome)"; Codex: "07:32", "07:32 on 20 Sep". Read as
 * local time; a bare time is its next occurrence. `null` when unreadable. */
function parseResetTime(text: string, now = new Date()): number | null {
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

/** A dateless reset ("resets 7:20pm") is read as that time's next occurrence,
 * so an old notice still on screen after its reset would point at tomorrow.
 * The 5-hour window can't reset further away than this: past it, the notice
 * is stale. */
const MAX_DATELESS_MS = 5 * 3_600_000 + 10 * 60_000;
const MONTH_RE = new RegExp(`\\b(?:${MONTHS.join("|")})[a-z]*\\b`, "i");

/** `parseResetTime`, but `null` for a dateless reset further away than the
 * 5-hour window allows (a stale notice, see MAX_DATELESS_MS). */
export function parseResetTimeGuarded(text: string, now = new Date()): number | null {
  const at = parseResetTime(text, now);
  if (at !== null && !MONTH_RE.test(text) && at - now.getTime() > MAX_DATELESS_MS) return null;
  return at;
}

function readPending(): Pending {
  return readJson(KEY, (v): v is Pending => !!v && typeof v === "object", {});
}

function writePending(pending: Pending) {
  writeJson(KEY, pending);
}

/** When this account's blocking limit lifts (ms), if it is blocked. */
export function accountBlockedUntil(pluginId: string, profile?: string): number | undefined {
  return readPending()[pendingKey(pluginId, profile)];
}

/** A non-default account is named after the agent: "Claude Code (Work)". */
async function notifyReset(key: string, at: number) {
  if (!getNotificationSettings().limitReset) return;
  const [pluginId, profile] = splitKey(key);
  const name = watchedName(pluginId) ?? pluginId;
  const agent = profile ? `${name} (${await profileName(profile)})` : name;
  void invoke("notify_once", {
    key: `${key}:${at}`,
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
    .map((m) => parseResetTimeGuarded(m.resets!))
    .filter((at): at is number => at !== null);
  return resets.length ? Math.max(...resets) : null;
}

function onUsage(pluginId: string, usage: UsageInfo, profile?: string) {
  if (!usage.ok || !watchedName(pluginId)) return;
  const key = pendingKey(pluginId, profile);
  const pending = readPending();
  const until = blockedUntil(usage);
  if (until !== null) {
    if (pending[key] === until) return;
    pending[key] = until;
  } else if (key in pending) {
    // Free again: right on time is the reset itself (the poll beat the
    // timer); well before it, the limit lifted some other way.
    if (pending[key] <= Date.now() + 60_000) void notifyReset(key, pending[key]);
    delete pending[key];
  } else {
    return;
  }
  writePending(pending);
}

function check() {
  const pending = readPending();
  const now = Date.now();
  let changed = false;
  for (const [key, at] of Object.entries(pending)) {
    if (now < at) continue;
    if (now - at < LATE_MS) void notifyReset(key, at);
    delete pending[key];
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
