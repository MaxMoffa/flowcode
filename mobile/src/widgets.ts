// Home-screen widgets (Android): feeds them a snapshot of the desktop's
// activity, and carries out what a tap on one asked for. Everything is best
// effort - a widget that can't update just shows older numbers.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { shortCwd } from "./common";
import { expectNewChat } from "./chats";
import { statsRequest } from "./gitRemote";
import { AGENT_KEY, cwdKey } from "./Home";
import { launchPath } from "./explorerPaths";
import { AGENTS, agentUsableOnHost } from "./NewTerminalSheet";
import { beginPending } from "./pending";
import { hostSupports, send, useRemoteSelector } from "./remote";
import { safeStorage } from "./store";
import { ACTION_TTL_MS, actionAgent, actionExpired, buildSnapshot, localMidnight, pickAgents, resumeTarget, type WidgetAction } from "./widgetsModel";
import type { ChatInfo, Tab } from "../../shared/remote-types";

const THROTTLE_MS = 5 * 60_000;
const PERIODIC_MS = 15 * 60_000;
const COUNT_DEBOUNCE_MS = 10_000;
/** As long as Terminals.tsx waits for a new chat (its agent starts first). */
const CHAT_WAIT_MS = 45_000;

/** The agents the Home launcher offers on this desktop. */
const usableAgents = () => {
  const caps = AGENTS.map((a) => a.id as string).filter(hostSupports);
  return AGENTS.filter((a) => agentUsableOnHost(a.id, caps));
};

let lastRefresh = 0;
let refreshing = false;

/** Pushes fresh numbers to the widgets: at most every 5 minutes unless `force`. */
async function refreshWidgets(force = false): Promise<void> {
  const now = Date.now();
  if (refreshing || !hostSupports("stats") || (!force && now - lastRefresh < THROTTLE_MS)) return;
  refreshing = true;
  try {
    const stats = await statsRequest(localMidnight(now));
    const agents = pickAgents(usableAgents().map((a) => a.id), safeStorage.get(AGENT_KEY));
    await invoke("widgets_update", { snapshot: buildSnapshot(stats, agents, Date.now()) });
    lastRefresh = now;
  } catch {
    // Best effort.
  } finally {
    refreshing = false;
  }
}

/** Keeps the widgets current while the link is online. */
export function WidgetSync(): null {
  const status = useRemoteSelector((s) => s.status);
  const host = useRemoteSelector((s) => s.host);
  const sessions = useRemoteSelector((s) => (s.tabs?.length ?? 0) + (s.chats?.length ?? 0));
  const online = status === "online" && !!host;
  const seen = useRef(sessions);

  useEffect(() => {
    if (!online) return;
    void refreshWidgets(true);
    const timer = setInterval(() => void refreshWidgets(), PERIODIC_MS);
    const onVisible = () => {
      if (!document.hidden) void refreshWidgets();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [online]);

  // A new or closed session changes today's numbers; the desktop may take a moment to log it.
  useEffect(() => {
    if (!online || seen.current === sessions) return;
    seen.current = sessions;
    const timer = setTimeout(() => void refreshWidgets(true), COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [online, sessions]);
  return null;
}

/** A tap not carried out yet: module-level, the app may still be locked or connecting when it arrives. */
let pendingAction: { action: WidgetAction; at: number } | null = null;

/** Asks the native side what a widget tap wanted (it hands it over once). */
async function takeWidgetAction(): Promise<void> {
  try {
    const action = await invoke<WidgetAction | null>("widgets_take_action");
    if (action?.action) pendingAction = { action, at: Date.now() };
  } catch {
    // Not on Android, or nothing to take.
  }
}

interface ActionDeps {
  hostName: string | undefined;
  tabs: Tab[];
  chats: ChatInfo[];
  lastOpened: string | null;
  open: (ptyId: string) => void;
  openChat: (chatId: string) => void;
}

function perform({ action, agent }: WidgetAction, d: ActionDeps) {
  if (action === "open") return;
  if (action === "resume") {
    const target = resumeTarget(d.lastOpened, d.tabs, d.chats);
    if (target?.kind === "tab") d.open(target.id);
    else if (target) d.openChat(target.id);
    return;
  }
  // "new" / "voice": the same request the Home launcher sends, without a first prompt.
  if (!hostSupports("chat")) return;
  const usable = usableAgents();
  const id = actionAgent(agent, safeStorage.get(AGENT_KEY), usable.map((a) => a.id));
  if (!id) return;
  const cwd = safeStorage.get(cwdKey(d.hostName)) || null;
  const where = cwd ? { cwd: launchPath(cwd) } : {};
  const name = usable.find((a) => a.id === id)?.name ?? id;
  send({ t: "newchat", cli: id, ...where });
  beginPending({ kind: "open", asChat: true, label: cwd ? `${name} · ${shortCwd(cwd)}` : name }, CHAT_WAIT_MS);
  expectNewChat({ agent: id, ...where }, action === "voice");
}

/**
 * Fetches a widget tap on start and whenever the app comes back, and carries
 * it out once the app can show the result: `ready` is paired, unlocked and online.
 */
export function useWidgetActions(ready: boolean, open: (ptyId: string) => void, openChat: (chatId: string) => void): void {
  const hostName = useRemoteSelector((s) => s.hostName);
  const tabs = useRemoteSelector((s) => s.tabs);
  const chats = useRemoteSelector((s) => s.chats);
  const lastOpened = useRemoteSelector((s) => s.lastOpened);
  // Tabs and (for a desktop that has chats) the chat list must be known, or "resume" would pick from half a picture.
  const loaded = !!tabs && (chats !== null || !hostSupports("chat"));
  const latest = useRef<{ ready: boolean; deps: ActionDeps | null }>({ ready: false, deps: null });
  latest.current = { ready: ready && loaded, deps: loaded ? { hostName, tabs: tabs!, chats: chats ?? [], lastOpened, open, openChat } : null };

  const tryRun = useRef(() => {});
  tryRun.current = () => {
    const p = pendingAction;
    if (!p) return;
    if (actionExpired(p.at, Date.now())) {
      pendingAction = null;
      return;
    }
    if (!latest.current.ready || !latest.current.deps) return;
    pendingAction = null;
    try {
      perform(p.action, latest.current.deps);
    } catch {
      // A widget tap must never break the app.
    }
  };

  useEffect(() => {
    const fetchAction = () => void takeWidgetAction().then(() => tryRun.current());
    fetchAction();
    const onVisible = () => {
      if (!document.hidden) fetchAction();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Runs the kept tap as soon as the app is ready; the timer drops it after its time if that never happens.
  useEffect(() => {
    tryRun.current();
    if (!pendingAction) return;
    const timer = setTimeout(() => tryRun.current(), ACTION_TTL_MS + 100);
    return () => clearTimeout(timer);
  }, [ready, tabs, chats, hostName]);
}
