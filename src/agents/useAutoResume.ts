import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TabAgent } from "./agentSessions";
import type { TermTab } from "../tabs/types";
import type { TerminalHandle } from "../terminal/Terminal";
import { t } from "../i18n";
import { accountBlockedUntil, parseResetTime } from "../notifications/limitResetWatcher";
import { autoResumeMessage, getAutoResumeSettings } from "./autoResumeSettings";

const CHECK_MS = 30_000;
/** Let the account's own usage refresh catch up before typing: the reset
 * time on screen is rounded to the minute. */
const GRACE_MS = 60_000;
/** A reset that passed this long ago is the leftover of an old session. */
const LATE_MS = 15 * 60_000;
const SCREEN_LINES = 20;

const PLUGIN_IDS: Record<string, string> = { claude: "claude-code", codex: "codex-cli" };
const CLI_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

const LIMIT_RE = /hit your (?:session |weekly |usage )?limit/gi;
const RESETS_RE = /resets\s+(.+?)(?:\n|$)/i;
const TRY_AGAIN_RE = /try again at\s+(.+?)[.\n]?(?:\n|$)/i;

/** A dateless reset ("resets 7:20pm") is read as that time's next occurrence,
 * so an old notice still on screen after its reset would point at tomorrow.
 * The 5-hour window can't reset further away than this: past it, the notice
 * is stale. */
const MAX_DATELESS_MS = 5 * 3_600_000 + 10 * 60_000;
const MONTH_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/** Reads a usage-limit notice off the screen text (its last occurrence - older
 * ones may still be scrolled in). `at` is the reset time, null when the notice
 * doesn't say, says it in a way parseResetTime can't read, or is a stale
 * dateless one (see MAX_DATELESS_MS). */
export function detectLimit(text: string, now = new Date()): { at: number | null } | null {
  let last = -1;
  for (const m of text.matchAll(LIMIT_RE)) last = m.index ?? last;
  if (last < 0) return null;
  const rest = text.slice(last);
  const when = rest.match(RESETS_RE)?.[1] ?? rest.match(TRY_AGAIN_RE)?.[1];
  const at = when ? parseResetTime(when, now) : null;
  if (at !== null && !MONTH_RE.test(when!) && at - now.getTime() > MAX_DATELESS_MS) return { at: null };
  return { at };
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
        deps.getTerm(id)?.getPtyId() !== a.ptyId ||
        deps.lastSubmitAt(id) > a.armedAt;
      if (stale) {
        armedRef.current.delete(id);
        changed = true;
      }
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
        const at = found.at ?? accountBlockedUntil(PLUGIN_IDS[agent.cli], tab.profileId) ?? null;
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
      const blocked = accountBlockedUntil(PLUGIN_IDS[a.cli], deps.getTab(id)?.profileId);
      if (blocked !== undefined && blocked > now) continue;
      const agent = agents.get(id);
      const tab = deps.getTab(id);
      const term = deps.getTerm(id);
      armedRef.current.delete(id);
      publish();
      // Re-checked at the last moment: the stale sweep above ran a tick ago.
      if (!tab || !term || !agent || agent.cli !== a.cli || agent.state === "busy") continue;
      if (term.getPtyId() !== a.ptyId || deps.lastSubmitAt(id) > a.armedAt) continue;
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
          body: t("autoResume.notification", { agent: CLI_NAMES[a.cli] ?? a.cli }),
        }).catch(() => {});
      }
    }
  }, [publish]);

  useEffect(() => {
    check();
  }, [agents, check]);

  useEffect(() => {
    const timer = setInterval(check, CHECK_MS);
    return () => clearInterval(timer);
  }, [check]);

  return { armed, cancel };
}
