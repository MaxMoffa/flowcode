import { useMemo, useState } from "react";
import { NewTabHost } from "../newtab/NewTabHost";
import { resolveNewTabLayout } from "../newtab/layouts";
import { NewTabSourceContext } from "../newtab/newTabSource";
import { useNewTabSettings } from "../newtab/newTabSettings";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { createRemoteNewTabSource, startOnHost } from "./remoteNewTabSource";
import { useHost } from "./remoteHosts";

/** A built-in layout that opens as a dialog: the one a PC-to-PC "+" falls back to when the picked layout is a page. */
const DIALOG_LAYOUT = "glass";

/** The new tab page as a dialog over another PC's workspace: the same layout as on this PC, fed with that PC's folders, agents and profiles (see remoteNewTabSource.ts). */
export function RemoteNewTab({ hostId, frontCwd, onClose }: { hostId: string; frontCwd: string | null; onClose: () => void }) {
  const host = useHost(hostId);
  const [{ layout }] = useNewTabSettings();
  const { fontSize } = useTerminalSettings();
  /** `undefined`: the PC picks; `null`: its default profile. */
  const [profile, setProfile] = useState<string | null | undefined>(undefined);
  const caps = host?.caps ?? [];
  const hostName = host?.hostName ?? "";
  const source = useMemo(() => createRemoteNewTabSource(hostId, hostName, frontCwd), [hostId, hostName, frontCwd]);
  const layoutId = resolveNewTabLayout(layout).dialog ? layout : DIALOG_LAYOUT;

  return (
    <NewTabSourceContext.Provider value={source}>
      <NewTabHost
        layoutId={layoutId}
        hidden={false}
        dialog
        onDismiss={onClose}
        defaultShell="system"
        startDir={frontCwd ?? ""}
        termFontSize={fontSize}
        onLaunch={({ cwd }) => {
          startOnHost(hostId, caps, { cwd, profile });
          onClose();
        }}
        onLaunchAgent={(agent, cwd) => {
          startOnHost(hostId, caps, { cwd: cwd ?? (frontCwd || undefined), agent, profile });
          onClose();
        }}
        onShellChange={() => {}}
        profileId={profile ?? undefined}
        onProfileChange={setProfile}
        onDone={() => {}}
      />
    </NewTabSourceContext.Provider>
  );
}
