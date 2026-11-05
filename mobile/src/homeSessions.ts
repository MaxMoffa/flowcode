// The home page's view of the sessions: terminals running an agent and chats
// in one normalized list, grouped by state, plus how long each has been in it.
import { useEffect, useState } from "react";
import { contextPercent } from "./common";
import type { ChatInfo, Tab } from "./remote";

export type SessionStatus = "waiting" | "busy" | "starting" | "idle" | "exited";

export interface Session {
  /** Stable across renders: "t:" + ptyId or "c:" + chatId. */
  key: string;
  kind: "term" | "chat";
  cli: string;
  label: string;
  cwd: string;
  status: SessionStatus;
  window: string;
  tab?: Tab;
  chat?: ChatInfo;
  /** Context window used, 0-100; terminals only. */
  contextPct: number | null;
}

/** Whether the desktop window has no other tab or chat: it refuses to close the last one. */
export function lastInWindow(window: string, tabs: Tab[], chats: ChatInfo[]): boolean {
  return tabs.filter((x) => x.window === window).length + chats.filter((c) => c.window === window).length <= 1;
}

/** Agent terminals (plain shells are not sessions) and chats as one list. */
export function sessionsOf(tabs: Tab[], chats: ChatInfo[]): Session[] {
  const out: Session[] = [];
  for (const tab of tabs) {
    if (!tab.cli) continue;
    out.push({ key: "t:" + tab.ptyId, kind: "term", cli: tab.cli, label: tab.label, cwd: tab.cwd, status: tab.status ?? "idle", window: tab.window, tab, contextPct: contextPercent(tab) });
  }
  for (const chat of chats) {
    out.push({ key: "c:" + chat.chatId, kind: "chat", cli: chat.agent, label: chat.label, cwd: chat.cwd, status: chat.status ?? "idle", window: chat.window, chat, contextPct: null });
  }
  return out;
}

export interface SessionGroups {
  waiting: Session[];
  /** Busy and starting. */
  working: Session[];
  idle: Session[];
  exited: Session[];
}

export function groupSessions(list: Session[]): SessionGroups {
  const of = (...states: SessionStatus[]) => list.filter((s) => states.includes(s.status));
  return { waiting: of("waiting"), working: of("busy", "starting"), idle: of("idle"), exited: of("exited") };
}

/** Remembers when each key's status was first seen and returns that moment; a different status starts over. */
export function trackSince(seen: Map<string, { status: SessionStatus; since: number }>, key: string, status: SessionStatus, now: number): number {
  const known = seen.get(key);
  if (known && known.status === status) return known.since;
  seen.set(key, { status, since: now });
  return now;
}

/**
 * The desktop does not say since when a session is in its state, so the phone
 * counts from when it first saw it: it restarts on every reconnect or app
 * launch. Re-renders every 30 s so the "for N min" labels move.
 */
const seen = new Map<string, { status: SessionStatus; since: number }>();
const TICK_MS = 30_000;

export function useStateSince(sessions: Session[]): { now: number; since: (key: string) => number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const at = Date.now();
  const since = new Map(sessions.map((s) => [s.key, trackSince(seen, s.key, s.status, at)]));
  for (const key of [...seen.keys()]) if (!since.has(key)) seen.delete(key);
  return { now, since: (key) => since.get(key) ?? now };
}
