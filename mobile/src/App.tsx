import { useEffect, useLayoutEffect, useState, type ReactElement } from "react";
import { AgentsScreen } from "./Agents";
import { AgentsIcon, SlidersIcon, TerminalIcon } from "./icons";
import { setLanguage, t } from "./i18n";
import { LockScreen } from "./Lock";
import { useLock } from "./applock";
import { PairingScreen } from "./Pairing";
import { Reconnect } from "./Reconnect";
import { setLastOpened, start, useRemote } from "./remote";
import { SettingsScreen } from "./Settings";
import { TerminalScreen } from "./TerminalScreen";
import { TerminalsScreen } from "./Terminals";
import { applyTheme } from "./theme";

type Page = "agents" | "terminals" | "settings";

/** Keeps --app-h at the visible height so the key bar rides above the on-screen keyboard. */
function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => document.documentElement.style.setProperty("--app-h", `${vv?.height ?? window.innerHeight}px`);
    apply();
    vv?.addEventListener("resize", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);
}

export function App() {
  const remote = useRemote();
  const [page, setPage] = useState<Page>("agents");
  const [openPty, setOpenPty] = useState<string | null>(null);
  const lock = useLock();
  useViewportHeight();

  // The phone wears the desktop's colors and language; before the first
  // settings message the cached ones (or the defaults) apply.
  setLanguage(remote.settings?.resolvedLanguage);
  useLayoutEffect(() => applyTheme(remote.settings), [remote.settings]);

  useEffect(() => {
    void start();
  }, []);

  function open(ptyId: string) {
    setLastOpened(ptyId);
    setOpenPty(ptyId);
  }

  // Locked: render nothing else, so no content ends up in the task switcher thumbnail.
  // Unpaired phones have nothing to protect. `checked` avoids a flash of content before the first probe.
  if (!lock.checked) return <div className="screen" />;
  if (lock.locked && remote.status !== "unpaired" && remote.status !== "loading") return <LockScreen />;

  // Unpaired (or mid-pairing, so a failure keeps its message on screen).
  if (remote.status === "unpaired" || remote.pairing) return <PairingScreen initialError={remote.error} />;
  if (remote.status === "loading") return <div className="screen" />;

  const tab = openPty ? remote.tabs?.find((x) => x.ptyId === openPty) : undefined;
  if (tab) {
    return (
      <>
        <Reconnect />
        <TerminalScreen key={tab.ptyId} tab={tab} status={remote.status} onBack={() => setOpenPty(null)} />
        <Toast />
      </>
    );
  }

  return (
    <div className="screen">
      <Reconnect />
      <main className="page">
        {page === "agents" && <AgentsScreen hostName={remote.hostName} tabs={remote.tabs} usage={remote.usage} onOpen={open} />}
        {page === "terminals" && <TerminalsScreen tabs={remote.tabs} onOpen={open} />}
        {page === "settings" && <SettingsScreen hostName={remote.hostName} settings={remote.settings} />}
      </main>
      <BottomNav page={page} onChange={setPage} />
      <Toast />
    </div>
  );
}

function Toast() {
  const { toast } = useRemote();
  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      {toast.text}
    </div>
  );
}


function BottomNav({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  const items: { id: Page; label: string; icon: ReactElement }[] = [
    { id: "agents", label: t("navAgents"), icon: <AgentsIcon /> },
    { id: "terminals", label: t("navTerminals"), icon: <TerminalIcon /> },
    { id: "settings", label: t("navSettings"), icon: <SlidersIcon /> },
  ];
  return (
    <nav className="nav" aria-label="main">
      {items.map((it) => (
        <button key={it.id} type="button" className={page === it.id ? "on" : ""} aria-current={page === it.id ? "page" : undefined} onClick={() => onChange(it.id)}>
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
