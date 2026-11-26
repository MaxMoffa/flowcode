import { useEffect, useState } from "react";
import { t, useI18n } from "../i18n";
import { rememberVisit, remoteEntries, useHost, useHostState } from "./remoteHosts";
import { RemoteChatView } from "./RemoteChatView";
import { RemoteTerminalView } from "./RemoteTerminalView";
import { RemoteFileViewer } from "./RemoteFileViewer";
import { RemoteDiffViewer } from "./RemoteDiffViewer";
import { RemoteLinks } from "./RemoteLinks";
import { useRemoteBrowserMirror } from "./remoteBrowserMirror";
import "./remote-hosts.css";

/** The content area while another PC is in front. Tabs already visited stay mounted (switching is instant); only the active one is shown.
 * Mounted with `key={hostId}`, so leaving a PC stops its streams. */
export function RemoteWorkspace({ hostId }: { hostId: string }) {
  useI18n();
  const host = useHost(hostId);
  useRemoteBrowserMirror(hostId);
  const { tabs, chats, activeKey } = useHostState(hostId);
  const entries = remoteEntries(tabs, chats);
  const [visited, setVisited] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!activeKey) return;
    // Closed tabs are dropped first: they would count against the cap of chats kept mounted.
    const live = new Set(remoteEntries(tabs, chats).map((e) => e.key));
    setVisited((prev) => {
      const kept = prev.filter((k) => live.has(k));
      if (kept[kept.length - 1] === activeKey && kept.length === prev.length) return prev;
      return rememberVisit(kept, activeKey);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const mounted = entries.filter((e) => e.key === activeKey || visited.includes(e.key));

  return (
    <div className="remote-workspace">
      {mounted.map((entry) =>
        entry.kind === "pty" ? (
          <RemoteLinks key={entry.key} hostId={hostId} cwd={entry.tab.cwd || undefined}>
            <RemoteTerminalView hostId={hostId} ptyId={entry.tab.ptyId} visible={entry.key === activeKey} cwd={entry.tab.cwd || undefined} />
          </RemoteLinks>
        ) : (
          <RemoteChatView key={entry.key} hostId={hostId} chatId={entry.chat.chatId} hidden={entry.key !== activeKey} />
        ),
      )}
      <RemoteFileViewer hostId={hostId} />
      <RemoteDiffViewer hostId={hostId} />
      {!activeKey && (
        <div className="remote-empty">
          {host?.status === "online" ? t("remoteHosts.noTabs", { name: host.hostName }) : host?.status === "connecting" ? t("remoteHosts.status.connectingDots") : t("remoteHosts.offlineEmpty", { name: host?.hostName ?? "" })}
        </div>
      )}
    </div>
  );
}
