import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import { useSidebarTab } from "../sidebar/Sidebar";
import { SegmentedSwitch } from "../lib/SegmentedSwitch";
import { useI18n } from "../i18n";
import { remoteEntries, useHost, useHostState } from "./remoteHosts";
import { RemoteExplorer } from "./RemoteExplorer";
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
  const [tab, setTab] = useSidebarTab(hasHistory);
  const options = [...(hasHistory ? [{ id: "history" as const, label: t("sidebar.tab.history") }] : []), ...(hasExplorer ? [{ id: "explorer" as const, label: t("git.tab.explorer") }] : [])];
  const shown: "history" | "explorer" = options.some((o) => o.id === tab) ? (tab as "history" | "explorer") : (options[0]?.id ?? "explorer");

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
          <div className="sidebar-explorer-tree">
            <RemoteExplorer hostId={hostId} cwd={cwd} visible={shown === "explorer"} />
          </div>
        </div>
      )}
    </aside>
  );
}
