import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { cacheWarningDelay, CACHE_IDLE_MS } from "./cacheWarning";
import { hasCap } from "../../shared/agentRegistry";

/** What the backend read from the Claude transcript: the cache lifetime and when the model was last called. */
interface CacheInfo {
  ttlMs: number;
  lastCallMs: number;
}

/** Dismissals by session (or chat, before it has one), valued with the "epoch" they silenced; survives remounts. */
const dismissals = new Map<string, number>();

/**
 * Whether to show the "prompt cache likely expired" card: one timeout to the exact moment, re-planned when the
 * activity changes. For a local Claude chat the transcript gives the real cache lifetime and the time of the last
 * model call (nothing shows until it answers); otherwise the 5-minute default and the last activity stand in.
 * A dismissal holds until there is a newer model call (a new turn), so "Continue" stays quiet until the next pause.
 */
export function useCacheWarning(opts: {
  agent: string;
  idle: boolean;
  items: { type: string }[];
  lastActivityAt: number | null;
  usageTokens: number | null;
  sessionId?: string | null;
  profileId: string | null;
  wslDistro: string | null;
  /** The transcript is readable from here (not a remote chat). */
  local: boolean;
  chatId: string;
  /** Reads the cache info some other way than the local command (a remote chat). Must be stable (memoized). */
  loadInfo?: (sessionId: string) => Promise<{ ttlMs: number; lastCallAt: string | null }>;
}) {
  const { agent, idle, items, lastActivityAt, usageTokens, sessionId, profileId, wslDistro, local, chatId, loadInfo } = opts;
  const [stale, setStale] = useState(false);
  const [, bump] = useState(0);
  const [fetched, setFetched] = useState<{ sid: string; info: CacheInfo | null } | null>(null);

  const wantsInfo = (local || !!loadInfo) && hasCap(agent, "cacheWarning") && !!sessionId;
  useEffect(() => {
    if (!wantsInfo || !sessionId) return;
    let alive = true;
    const load = loadInfo
      ? loadInfo(sessionId)
      : invoke<{ ttlMs: number; lastCallAt: string | null }>("chat_cache_info", { sessionId, profile: profileId, wslDistro });
    load
      .then((r) => {
        const last = r.lastCallAt ? Date.parse(r.lastCallAt) : NaN;
        if (alive) setFetched({ sid: sessionId, info: Number.isFinite(last) && r.ttlMs > 0 ? { ttlMs: r.ttlMs, lastCallMs: last } : null });
      })
      .catch(() => {
        if (alive) setFetched({ sid: sessionId, info: null });
      });
    return () => {
      alive = false;
    };
  }, [wantsInfo, sessionId, profileId, wslDistro, idle, loadInfo]);

  // undefined: still loading (no notice); null: unavailable (fall back to the defaults).
  const info: CacheInfo | null | undefined = !wantsInfo ? null : fetched?.sid === sessionId ? fetched.info : undefined;
  const lastAt = info ? Math.max(info.lastCallMs, lastActivityAt ?? 0) : lastActivityAt;
  const ttlMs = info ? info.ttlMs : CACHE_IDLE_MS;
  const epoch = info ? info.lastCallMs : lastActivityAt;
  const key = sessionId ?? chatId;
  const dismissed = epoch !== null && dismissals.get(key) === epoch;

  useEffect(() => {
    setStale(false);
    if (dismissed || info === undefined) return;
    const delay = cacheWarningDelay({ agent, idle, items, lastActivityAt: lastAt, now: Date.now(), usageTokens, ttlMs });
    if (delay === null) return;
    if (delay === 0) {
      setStale(true);
      return;
    }
    const timer = setTimeout(() => setStale(true), delay);
    return () => clearTimeout(timer);
  }, [agent, idle, items, lastAt, usageTokens, ttlMs, dismissed, info]);

  const dismiss = useCallback(() => {
    if (epoch === null) return;
    dismissals.set(key, epoch);
    bump((n) => n + 1);
  }, [key, epoch]);

  const show = stale && !dismissed;
  return { show, dismiss, idleMs: show && lastAt !== null ? Date.now() - lastAt : 0, tokens: usageTokens };
}
