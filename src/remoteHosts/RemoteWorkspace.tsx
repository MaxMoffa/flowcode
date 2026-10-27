import { useEffect, useState } from "react";
import { t, useI18n } from "../i18n";
import { remoteEntries, useHost, useHostState } from "./remoteHosts";
import { RemoteChatView } from "./RemoteChatView";
import { RemoteTerminalView } from "./RemoteTerminalView";
import "./remote-hosts.css";

/** The content area while another PC is in front. Tabs already visited stay mounted (switching is instant); only the active one is shown.
 * Mounted with `key={hostId}`, so leaving a PC stops its streams. */
export function RemoteWorkspace({ hostId }: { hostId: string }) {
  useI18n();
  const host = useHost(hostId);
  const { tabs, chats, activeKey } = useHostState(hostId);
  const entries = remoteEntries(tabs, chats);
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (activeKey) setVisited((prev) => (prev.has(activeKey) ? prev : new Set(prev).add(activeKey)));
  }, [activeKey]);

  const mounted = entries.filter((e) => e.key === activeKey || visited.has(e.key));

  return (
    <div className="remote-workspace">
      {mounted.map((entry) =>
        entry.kind === "pty" ? (
          <RemoteTerminalView key={entry.key} hostId={hostId} ptyId={entry.tab.ptyId} visible={entry.key === activeKey} />
        ) : (
          <RemoteChatView key={entry.key} hostId={hostId} chatId={entry.chat.chatId} hidden={entry.key !== activeKey} />
        ),
      )}
      {!activeKey && (
        <div className="remote-empty">
          {host?.status === "online" ? t("remoteHosts.noTabs", { name: host.hostName }) : host?.status === "connecting" ? t("remoteHosts.status.connectingDots") : t("remoteHosts.offlineEmpty", { name: host?.hostName ?? "" })}
        </div>
      )}
    </div>
  );
}
