// Pure parts of the Android home-screen widgets: the snapshot the native side
// draws from, and the decisions behind a widget tap. Side effects live in widgets.ts.
import type { ActivityStats, ChatInfo, Tab } from "../../shared/remote-types";

export interface WidgetSnapshot {
  v: 1;
  /** Local midnight of "today", ms. */
  dayStart: number;
  /** Sessions per day, 7 entries, oldest first; the last is today. */
  days: number[];
  streak: number;
  todayMinutes: number;
  /** Up to 4 agent ids the user can start, the remembered one first. */
  agents: string[];
  updatedAt: number;
}

export const MAX_WIDGET_AGENTS = 4;

/** Local midnight of the day `now` falls in. */
export const localMidnight = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The agents to offer: the remembered one first (if usable), then the rest in launcher order. */
export function pickAgents(usable: string[], remembered: string | null | undefined): string[] {
  const first = remembered && usable.includes(remembered) ? [remembered] : [];
  return [...first, ...usable.filter((a) => a !== remembered)].slice(0, MAX_WIDGET_AGENTS);
}

/** Stats are clamped to 7 non-negative day counts, so an odd reply can't break the native drawing. */
export function buildSnapshot(stats: ActivityStats, agents: string[], now: number): WidgetSnapshot {
  const days = Array.from({ length: 7 }, (_, i) => count(stats.days?.[i]));
  return { v: 1, dayStart: localMidnight(now), days, streak: count(stats.streak), todayMinutes: count(stats.todayMinutes), agents, updatedAt: now };
}

export interface WidgetAction {
  action: "open" | "new" | "voice" | "resume";
  agent?: string;
}

/** A tapped widget's request is kept this long while the app gets ready, then dropped. */
export const ACTION_TTL_MS = 60_000;

export const actionExpired = (at: number, now: number): boolean => now - at > ACTION_TTL_MS;

/** What "resume" opens: the last terminal still in the tabs, else the most recently listed chat. */
export function resumeTarget(lastOpened: string | null, tabs: Tab[], chats: ChatInfo[]): { kind: "tab" | "chat"; id: string } | null {
  if (lastOpened && tabs.some((x) => x.ptyId === lastOpened)) return { kind: "tab", id: lastOpened };
  const chat = chats[chats.length - 1];
  return chat ? { kind: "chat", id: chat.chatId } : null;
}

/** The agent for a "new"/"voice" tap: the one asked, else the remembered, else the first usable - always one the user can start. */
export function actionAgent(asked: string | undefined, remembered: string | null, usable: string[]): string | undefined {
  return [asked, remembered].find((a): a is string => !!a && usable.includes(a)) ?? usable[0];
}
