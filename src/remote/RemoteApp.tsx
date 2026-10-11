import { useEffect, useRef, useState } from "react";
import { RemoteClient, getToken, setToken, type RemoteTab, type Status } from "./client";
import { PairScreen, UnpairedScreen } from "./PairScreen";
import { TabsScreen } from "./TabsScreen";
import { TerminalScreen } from "./TerminalScreen";

/** "pair" when the QR link brought a one-time code, "unpaired" with neither
 * code nor token, "app" once there's a token to connect with. */
type Phase = { kind: "pair"; code: string } | { kind: "unpaired" } | { kind: "app" };

function initialPhase(): Phase {
  const m = /[#&]pair=([^&]+)/.exec(location.hash);
  if (m) return { kind: "pair", code: decodeURIComponent(m[1]) };
  return getToken() ? { kind: "app" } : { kind: "unpaired" };
}

export function RemoteApp() {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  if (phase.kind === "pair") {
    return (
      <PairScreen
        code={phase.code}
        onPaired={(token) => {
          setToken(token);
          // Drop the one-time code from the address bar and history entry.
          history.replaceState(null, "", location.pathname + location.search);
          setPhase({ kind: "app" });
        }}
      />
    );
  }
  if (phase.kind === "unpaired") return <UnpairedScreen />;
  return (
    <Session
      onAuthFailed={() => {
        setToken(null);
        setPhase({ kind: "unpaired" });
      }}
    />
  );
}

function Session({ onAuthFailed }: { onAuthFailed: () => void }) {
  const [client, setClient] = useState<RemoteClient | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [tabs, setTabs] = useState<RemoteTab[] | null>(null);
  const [openPty, setOpenPty] = useState<string | null>(null);
  const authFailed = useRef(onAuthFailed);
  authFailed.current = onAuthFailed;

  useEffect(() => {
    const token = getToken();
    if (!token) {
      authFailed.current();
      return;
    }
    const c = new RemoteClient(token, () => authFailed.current());
    setClient(c);
    const offStatus = c.onStatus(setStatus);
    const offMsg = c.onMessage((m) => {
      if (m.t === "tabs") setTabs(m.tabs);
    });
    return () => {
      offStatus();
      offMsg();
      c.stop();
    };
  }, []);

  if (!client) return null;
  const tab = openPty ? tabs?.find((x) => x.ptyId === openPty) : undefined;
  if (tab) {
    return <TerminalScreen client={client} tab={tab} status={status} onBack={() => setOpenPty(null)} />;
  }
  return (
    <TabsScreen
      tabs={tabs}
      status={status}
      onOpen={setOpenPty}
      onUnpair={() => {
        setToken(null);
        onAuthFailed();
      }}
    />
  );
}
