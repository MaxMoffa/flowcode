import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TabAgent } from "./agentSessions";
import type { TermTab } from "../tabs/types";
import type { TerminalHandle } from "../terminal/Terminal";
import { t } from "../i18n";
import { accountBlockedUntil, parseResetTimeGuarded } from "../notifications/limitResetWatcher";
import { CLI_INFO, cliName } from "./cliInfo";
import { autoResumeMessage, getAutoResumeSettings } from "./autoResumeSettings";

const CHECK_MS = 30_000;
/** Let the account's own usage refresh catch up before typing: the reset
 * time on screen is rounded to the minute. */
const GRACE_MS = 60_000;
/** A reset that passed this long ago is the leftover of an old session. */
const LATE_MS = 15 * 60_000;
const SCREEN_LINES = 20;

const LIMIT_RE = /hit your (?:session |weekly |usage )?limit/gi;
const RESETS_RE = /resets\s+(.+?)(?:\n|$)/i;
const TRY_AGAIN_RE = /try again at\s+(.+?)[.\n]?(?:\n|$)/i;

/** Reads a usage-limit notice off the screen text (its last occurrence - older
 * ones may still be scrolled in). `at` is the reset time, null when the notice
 * doesn't say, says it in a way parseResetTime can't read, or is a stale
 * dateless one (see parseResetTimeGuarded). */
function detectLimit(text: string, now = new Date()): { at: number | null } | null {
  let last = -1;
  for (const m of text.matchAll(LIMIT_RE)) last = m.index ?? last;
  if (last < 0) return null;
  const rest = text.slice(last);
  const when = rest.match(RESETS_RE)?.[1] ?? rest.match(TRY_AGAIN_RE)?.[1];
  return { at: when ? parseResetTimeGuarded(when, now) : null };
}

interface Deps {
  getTab: (id: string) => TermTab | undefined;
  getTerm: (id: string) => TerminalHandle | undefined;
  /** When the user last pressed Enter in that tab (ms, 0 if never). */
  lastSubmitAt: (id: string) => number;
}

interface Armed {
  at: number;
  cli: string;
  ptyId: string | null | undefined;
  armedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** When Claude Code or Codex in a tab stops at its usage limit, types a
 * "continue" message into it once the limit resets (if enabled in Settings).
 * Returns the tabs waiting for that, with their reset time, for the tab strip;
 * `cancel` gives one up. */
export function useAutoResume(
  agents: Map<string, TabAgent>,
  deps: Deps,
): { armed: ReadonlyMap<string, number>; cancel: (tabId: string) => void } {
  const armedRef = useRef(new Map<string, Armed>());
  /** The reset each tab was last woken for: the old notice stays on screen
   * after a wake and must not arm it again. */
  const lastWokenFor = useRef(new Map<string, number>());
  const [armed, setArmed] = useState<ReadonlyMap<string, number>>(() => new Map());
  // The interval outlives renders, so it reads the latest of these.
  const latest = useRef({ agents, deps });
  latest.current = { agents, deps };

  const publish = useCallback(() => {
    setArmed(new Map([...armedRef.current].map(([id, a]) => [id, a.at])));
  }, []);

  const cancel = useCallback(
    (tabId: string) => {
      if (armedRef.current.delete(tabId)) publish();
    },
    [publish],
  );

  const check = useCallback(() => {
    const { agents, deps } = latest.current;
    const enabled = getAutoResumeSettings().enabled;
    let changed = false;
    const now = Date.now();

    // Drop what no longer holds: the agent is gone, changed, or the user took over.
    for (const [id, a] of [...armedRef.current]) {
      const agent = agents.get(id);
      const stale =
        !enabled ||
        !deps.getTab(id) ||
        !agent ||
        agent.cli !== a.cli ||
        (deps.getTerm(id)?.getPtyId() ?? null) !== (a.ptyId ?? null) ||
        deps.lastSubmitAt(id) > a.armedAt;
      if (stale) {
        armedRef.current.delete(id);
        changed = true;
      }
    }

    // Tabs that are gone: their last wake must not outlive them.
    for (const id of [...lastWokenFor.current.keys()]) {
      if (!agents.has(id)) lastWokenFor.current.delete(id);
    }

    if (enabled) {
      for (const [id, agent] of agents) {
        if (armedRef.current.has(id) || (agent.cli !== "claude" && agent.cli !== "codex")) continue;
        if (agent.state === "busy") continue;
        const tab = deps.getTab(id);
        const term = deps.getTerm(id);
        if (!tab || !term) continue;
        const found = detectLimit(term.screenTail(SCREEN_LINES), new Date(now));
        if (!found) continue;
        const at = found.at ?? accountBlockedUntil(CLI_INFO[agent.cli].pluginId, tab.profileId) ?? null;
        if (at === null || at < now - LATE_MS) continue;
        const woken = lastWokenFor.current.get(id);
        if (woken !== undefined && at <= woken) continue;
        armedRef.current.set(id, { at, cli: agent.cli, ptyId: term.getPtyId(), armedAt: now });
        changed = true;
      }
    }
    if (changed) publish();

    for (const [id, a] of [...armedRef.current]) {
      if (now < a.at + GRACE_MS) continue;
      const blocked = accountBlockedUntil(CLI_INFO[a.cli as "claude" | "codex"].pluginId, deps.getTab(id)?.profileId);
      if (blocked !== undefined && blocked > now) continue;
      const agent = agents.get(id);
      const tab = deps.getTab(id);
      const term = deps.getTerm(id);
      // Busy right now: typing would interleave with its output. Stay armed so
      // the next tick retries (the stale sweep drops it if the user takes over).
      if (agent?.state === "busy" && agent.cli === a.cli) continue;
      armedRef.current.delete(id);
      publish();
      // Re-checked at the last moment: the stale sweep above ran a tick ago.
      if (!tab || !term || !agent || agent.cli !== a.cli) continue;
      if ((term.getPtyId() ?? null) !== (a.ptyId ?? null) || deps.lastSubmitAt(id) > a.armedAt) continue;
      lastWokenFor.current.set(id, a.at);
      void (async () => {
        // Esc closes the limit options menu Claude Code may be showing.
        if (a.cli === "claude") {
          term.sendInput("\x1b");
          await sleep(300);
        }
        term.sendInput(autoResumeMessage());
        await sleep(250);
        term.sendInput("\r");
      })();
      if (!tab.notifyMuted) {
        void invoke("notify_show", {
          label: getCurrentWindow().label,
          tabId: id,
          title: tab.label,
          body: t("autoResume.notification", { agent: cliName(a.cli) }),
        }).catch(() => {});
      }
    }
  }, [publish]);

  // The agents map is rebuilt on every tab change; only a cli/state change
  // can alter what check() decides.
  let agentsKey = "";
  for (const [id, a] of agents) agentsKey += `${id}:${a.cli}:${a.state}|`;
  useEffect(() => {
    if (!getAutoResumeSettings().enabled && armedRef.current.size === 0) return;
    check();
  }, [agentsKey, check]);

  useEffect(() => {
    const timer = setInterval(check, CHECK_MS);
    return () => clearInterval(timer);
  }, [check]);

  return { armed, cancel };
}
