import { useEffect, useMemo, useState } from "react";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import { useSidebarTab } from "../sidebar/Sidebar";
import { SegmentedSwitch } from "../lib/SegmentedSwitch";
import { useI18n } from "../i18n";
import { expectNewTab, remoteEntries, sendToHost, terminalLike, useHost, useHostState } from "./remoteHosts";
import { FileTree } from "../sidebar/FileTree";
import { FsBackendContext } from "../sidebar/fsBackend";
import { remoteFsBackend } from "./remoteFs";
import { FavoritesContext } from "../favorites/favoritesContext";
import { remoteFavorites } from "../favorites/favoritesStore";
import { GitDock } from "../sidebar/GitDock";
import { GitBackendContext, type GitStatus } from "../git/gitStatus";
import { remoteGitBackend } from "./remoteGit";
import { openRemoteFile } from "./remoteFiles";
import { openRemoteDiff } from "./RemoteDiffViewer";
import { RemoteAgentPanel, type RemoteAgentTarget } from "./RemoteAgentPanel";
import { RemoteHistoryPanel, type RemoteAgentTab } from "./RemoteHistoryPanel";
import "../sidebar/sidebar.css";

const isAgentCli = (v: string | undefined): v is AgentCli => !!v && (AGENT_CLIS as readonly string[]).includes(v);

/** The side panel while another PC is in front: its History (the sessions of the front tab's project) and its folders,
 * both read from that PC, in place of this PC's. */
export function RemoteSidebar({ hostId }: { hostId: string }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const { tabs, chats, activeKey } = useHostState(hostId);
  const front = remoteEntries(tabs, chats).find((e) => e.key === activeKey);
  const cwd = front ? (front.kind === "pty" ? front.tab.cwd : front.chat.cwd) : "";
  const agent: RemoteAgentTab | null = !front
    ? null
    : front.kind === "chat"
      ? isAgentCli(front.chat.agent)
        ? { cwd, cli: front.chat.agent, profile: front.chat.profile, sessionId: front.chat.sessionId, view: "chat" }
        : null
      : isAgentCli(front.tab.cli)
        ? { cwd, cli: front.tab.cli, profile: front.tab.profile, sessionId: front.tab.sessionId, view: "terminal" }
        : null;
  const caps = host?.caps ?? [];
  const hasHistory = !!agent && caps.includes("history");
  const hasExplorer = caps.includes("fileExplorer");
  const hasGit = caps.includes("git");
  const insightTarget: RemoteAgentTarget | null =
    agent && front && caps.includes("agentInsight")
      ? front.kind === "chat"
        ? { chatId: front.chat.chatId, cli: agent.cli, profile: agent.profile, busy: front.chat.status === "busy" || front.chat.status === "waiting", label: front.chat.label }
        : { ptyId: front.tab.ptyId, cli: agent.cli, profile: agent.profile, busy: front.tab.status === "busy", label: front.tab.label }
      : null;
  const [tab, setTab] = useSidebarTab(hasHistory || !!insightTarget);
  const options = [
    ...(hasHistory ? [{ id: "history" as const, label: t("sidebar.tab.history") }] : []),
    ...(hasExplorer ? [{ id: "explorer" as const, label: t("git.tab.explorer") }] : []),
    ...(insightTarget ? [{ id: "agent" as const, label: t("sidebar.tab.agent") }] : []),
  ];
  const shown: "history" | "explorer" | "agent" = options.some((o) => o.id === tab) ? (tab as "history" | "explorer" | "agent") : (options[0]?.id ?? "explorer");
  // The other PC's repository, through its `git` messages; the drawer below the folders shows it.
  const git = useMemo(() => remoteGitBackend(hostId), [hostId]);
  const fs = useMemo(() => remoteFsBackend(hostId, host?.caps), [hostId, host?.caps]);
  const favorites = useMemo(() => remoteFavorites(hostId), [hostId]);
  // The folder the explorer shows: the front tab's, until browsed elsewhere; it follows the tab when that moves.
  const [path, setPath] = useState(cwd);
  useEffect(() => setPath(cwd), [cwd, hostId]);
  const [status, setStatus] = useState<{ root: string; status: GitStatus } | null>(null);
  const summary = useMemo(() => {
    if (!status) return null;
    const s = status.status;
    return { branch: s.branch, ahead: s.ahead, behind: s.behind, count: s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length };
  }, [status]);

  return (
    <aside className="sidebar">
      {options.length > 1 && (
        <div className="sidebar-switch">
          <SegmentedSwitch options={options} value={shown} onChange={setTab} ariaLabel={t("git.tabs.aria")} idPrefix="remote-sidebar" />
        </div>
      )}
      {options.length === 0 && <div className="file-tree-loading">{t("remoteHosts.sidebar.unsupported")}</div>}
      {hasHistory && agent && (
        <div className="sidebar-panel" role="tabpanel" hidden={shown !== "history"}>
          <RemoteHistoryPanel hostId={hostId} agent={agent} visible={shown === "history"} />
        </div>
      )}
      {hasExplorer && cwd && (
        <div className="sidebar-panel" role="tabpanel" hidden={shown !== "explorer"}>
          <GitBackendContext.Provider value={git}>
            <div className="sidebar-explorer-tree">
              {host?.status === "online" ? (
                <FsBackendContext.Provider value={fs}>
                  <FavoritesContext.Provider value={favorites}>
                  <FileTree
                    favorites
                    cwd={path}
                    onNavigate={setPath}
                    onGoHome={() => setPath(cwd)}
                    onOpenFile={(file) => openRemoteFile({ hostId, path: file })}
                    onOpenTerminal={(dir) => {
                      expectNewTab(hostId, terminalLike(dir));
                      void sendToHost(hostId, { t: "newtab", cwd: dir });
                    }}
                    visible={shown === "explorer"}
                  />
                  </FavoritesContext.Provider>
                </FsBackendContext.Provider>
              ) : (
                <div className="file-tree-loading">{t("remoteHosts.offlineEmpty", { name: host?.hostName ?? "" })}</div>
              )}
            </div>
            {hasGit && (
              <GitDock
                cwd={cwd}
                visible={shown === "explorer"}
                onOpenFile={(path) => openRemoteFile({ hostId, path })}
                onOpenDiff={(root, change, staged) => openRemoteDiff({ hostId, root, path: change.path, staged })}
                onStatusChange={setStatus}
                summary={summary}
              />
            )}
          </GitBackendContext.Provider>
        </div>
      )}
      {insightTarget && shown === "agent" && (
        <div className="sidebar-panel" role="tabpanel">
          <RemoteAgentPanel key={insightTarget.chatId ?? insightTarget.ptyId} hostId={hostId} target={insightTarget} />
        </div>
      )}
    </aside>
  );
}
