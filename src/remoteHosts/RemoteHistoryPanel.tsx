import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import { buildHistoryRows, type HistoryEntries, type HistoryRow, type OpenSession } from "../agents/historyRows";
import { HistoryView, type HiddenRowsStore } from "../agents/HistoryView";
import type { HistoryItem } from "../agents/historyDelete";
import { chatKey, ptyKey } from "../../shared/remoteEntries";
import { getRemoteHiddenRows, hideRemoteRows, remoteHiddenKey, remoteHistoryDelete, unhideRemoteRows, useRemoteHiddenRows } from "./remoteHistoryDelete";
import { hostRequest } from "./hostRequest";
import { chatLike, expectNewTab, terminalLike, selectRemoteKey, sendToHost, useHost, useHostState } from "./remoteHosts";

const POLL_MS = 15_000;
const EMPTY: HistoryEntries = { claude: [], codex: [], vibe: [], opencode: [], cline: [] };
const isAgentCli = (cli: string | undefined): cli is AgentCli => !!cli && (AGENT_CLIS as readonly string[]).includes(cli);
const statusOf = (s: string | undefined): "busy" | "waiting" | "idle" | undefined => (s === "busy" || s === "waiting" ? s : s === "exited" ? undefined : "idle");
const REMOTE_HIDDEN: HiddenRowsStore = { use: useRemoteHiddenRows, get: getRemoteHiddenRows, hide: hideRemoteRows, unhide: unhideRemoteRows };

/** What the History tab is shown for: the agent tab in front on the other PC. */
export interface RemoteAgentTab {
  cwd: string;
  cli: AgentCli;
  profile?: string;
  sessionId?: string;
  /** How a saved session picked here opens: the same kind of tab as the one in front. */
  view: "chat" | "terminal";
}

/** The sessions of the project the other PC's tab in front works in: saved ones read by that PC plus those open in its tabs. */
export function RemoteHistoryPanel({ hostId, agent, visible }: { hostId: string; agent: RemoteAgentTab; visible: boolean }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const { chats, tabs } = useHostState(hostId);
  const { cwd } = agent;
  const canResume = !!host?.caps.includes("resume");
  const canDelete = !!host?.caps.includes("historyDelete");
  const online = host?.status === "online";
  const [data, setData] = useState<{ cwd: string; roots: string[]; entries: HistoryEntries } | null>(null);
  const [failed, setFailed] = useState(false);
  const [, tick] = useState(0);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    hostRequest(hostId, "history", (requestId) => ({ t: "history", requestId, cwd }))
      .then((m) => {
        const r = m.result;
        if (!r || id !== seq.current) return;
        setFailed(false);
        setData({
          cwd,
          roots: r.roots.length > 0 ? r.roots : [cwd],
          entries: {
            claude: r.claude as HistoryEntries["claude"],
            codex: r.codex as HistoryEntries["codex"],
            vibe: r.vibe as HistoryEntries["vibe"],
            opencode: r.opencode as HistoryEntries["opencode"],
            cline: (r.cline ?? []) as HistoryEntries["cline"],
          },
        });
      })
      // The last list stays on screen; the error only shows when there is none.
      .catch(() => id === seq.current && setFailed(true));
  }, [hostId, cwd]);

  useEffect(() => {
    if (!visible || !online) return;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
      tick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [visible, online, load]);

  // Another folder or PC: nothing of the previous list stays.
  const mine = data && data.cwd === cwd ? data : null;

  const rows = useMemo(() => {
    const open: OpenSession[] = [];
    for (const c of chats) {
      if (!isAgentCli(c.agent)) continue;
      open.push({ cli: c.agent, sessionId: c.sessionId ?? "", title: c.label, cwd: c.cwd, wslDistro: null, profile: c.profile ?? null, tabId: chatKey(c.chatId), status: statusOf(c.status), at: null });
    }
    for (const x of tabs) {
      if (!isAgentCli(x.cli)) continue;
      open.push({ cli: x.cli, sessionId: x.sessionId ?? "", title: x.label, cwd: x.cwd, wslDistro: null, profile: x.profile ?? null, tabId: ptyKey(x.ptyId), status: statusOf(x.status), at: null });
    }
    return buildHistoryRows({ entries: mine?.entries ?? EMPTY, roots: mine?.roots ?? [cwd], open });
  }, [mine, cwd, chats, tabs]);

  const keyOf = useCallback((cli: string, sessionId: string) => remoteHiddenKey(hostId, `${cli}:${sessionId}`), [hostId]);

  const openRow = (row: HistoryRow) => {
    // Open there: its tab comes to the front.
    if (row.tabId) return selectRemoteKey(hostId, row.tabId);
    if (!canResume || !row.sessionId) return;
    expectNewTab(hostId, agent.view === "chat" ? chatLike(row.cli, row.cwd) : terminalLike(row.cwd, row.cli));
    void sendToHost(hostId, { t: "resume", cwd: row.cwd, sessionId: row.sessionId, cli: row.cli, ...(row.wslDistro ? { wslDistro: row.wslDistro } : {}), ...(row.profile ? { profile: row.profile } : {}), view: agent.view });
  };

  /** Deletes on the PC (chats open in one of its tabs are never deleted); resolves with the session ids that failed. */
  const deleteItems = async (items: HistoryItem[]) => new Set((await remoteHistoryDelete(hostId, items)).failed.map((f) => f.sessionId));

  const newSession = (cli: AgentCli) => {
    expectNewTab(hostId, chatLike(cli, cwd));
    void sendToHost(hostId, { t: "newchat", cli, cwd, ...(agent.profile != null ? { profile: agent.profile } : {}) });
  };

  return (
    <HistoryView
      rows={rows}
      pending={!mine && online && !failed}
      error={failed && !mine ? t("remoteHosts.history.error") : undefined}
      projectCwd={cwd}
      currentSessionId={agent.sessionId}
      hidden={REMOTE_HIDDEN}
      keyOf={keyOf}
      openRow={openRow}
      canOpen={(row) => !!row.tabId || canResume}
      deleteItems={canDelete ? deleteItems : undefined}
      deleteDisabled={!online}
      newSession={{
        currentCli: agent.cli,
        clis: AGENT_CLIS,
        // The host runs the session under the front tab's profile: local profiles mean nothing there.
        profileId: agent.profile,
        currentProfileId: agent.profile,
        profilePicker: false,
        onNew: (cli) => newSession(cli),
        disabled: !online,
      }}
    />
  );
}
