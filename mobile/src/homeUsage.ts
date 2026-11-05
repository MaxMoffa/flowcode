// Pure helpers behind the home page's "Limits and costs" cards: tone, time
// left, pace against the window, and the pay-per-use summary. No React, so
// they are tested on their own.
import { parseResetTimeGuarded } from "../../src/agents/limitText";
import { t } from "./i18n";
import type { UsageMetric } from "./remote";

export type Tone = "hot" | "warm" | "";

/** Colour step of a gauge: red from 90%, amber from 70%. `percent` is 0-100. */
export function usageTone(percent: number): Tone {
  return percent >= 90 ? "hot" : percent >= 70 ? "warm" : "";
}

/** How long the limit windows last, by metric kind; other kinds have no window, so no tick and no pace. */
export const WINDOW_MS: Record<string, number> = { session: 5 * 3_600_000, week: 7 * 86_400_000 };

/** "45 min", "2 h 10", "3 g 5 h": the time left, coarser the longer it is. */
export function leftText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return t("timeMin", { n: min });
  if (min < 1440) return t("timeHours", { h: Math.floor(min / 60), m: String(min % 60).padStart(2, "0") });
  return t("timeDays", { d: Math.floor(min / 1440), h: Math.floor((min % 1440) / 60) });
}

/** Milliseconds until the reset the CLI worded; null when unreadable, stale or already past (the phone cannot tell). */
export function resetIn(resets: string | undefined, now: Date): number | null {
  if (!resets) return null;
  const at = parseResetTimeGuarded(resets, now);
  if (at === null) return null;
  const ms = at - now.getTime();
  return ms >= 0 ? ms : null;
}

export interface Pace {
  /** Share of the window already gone, 0-100. */
  elapsed: number;
  /** Using the window faster ("over") or slower ("under") than time passes, with a 10-point margin. */
  state: "over" | "under" | "on";
}

/** Compares what was used (`percent`, 0-100) with how much of the window has passed. */
export function pace(percent: number, leftMs: number, windowMs: number): Pace {
  const elapsed = Math.min(100, Math.max(0, Math.round((1 - leftMs / windowMs) * 100)));
  const gap = percent - elapsed;
  return { elapsed, state: gap > 10 ? "over" : gap < -10 ? "under" : "on" };
}

export interface SpendSummary {
  today?: UsageMetric;
  week?: UsageMetric;
  month?: UsageMetric;
  /** The month's cost spread over 30 days; null without a month (or with nothing spent in it). */
  dailyAverage: number | null;
  /** Today's cost over the daily average; null when either is missing. */
  ratio: number | null;
  state: "over" | "under" | "on" | null;
}

/** Picks the today / week / month spend rows and compares today with the daily average. */
export function spendSummary(metrics: UsageMetric[]): SpendSummary {
  const by = (period: string) => metrics.find((m) => m.kind === "spend" && m.period === period);
  const today = by("today");
  const week = by("week");
  const month = by("month");
  const dailyAverage = month && typeof month.cost === "number" && month.cost > 0 ? month.cost / 30 : null;
  const ratio = dailyAverage !== null && typeof today?.cost === "number" ? today.cost / dailyAverage : null;
  const state = ratio === null ? null : ratio >= 1.3 ? "over" : ratio <= 0.7 ? "under" : "on";
  return { today, week, month, dailyAverage, ratio, state };
}

/** Token counts the short way ("410K", "7.4M"); a local copy because the desktop's own pulls in desktop-only modules. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Dollars as the cards show them: cents under 100, whole above. */
export function money(v: number): string {
  return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
}
