import { useEffect, useState, type ReactElement } from "react";
import { ActionsScreen } from "./Actions";
import { AgentsScreen } from "./Agents";
import { FilesScreen } from "./Files";
import { AgentsIcon, BoltIcon, FolderIcon, TerminalIcon } from "./icons";
import { t } from "./i18n";
import { PairingScreen } from "./Pairing";
import { setLastOpened, start, unpair, useRemote } from "./remote";
import { TerminalScreen } from "./TerminalScreen";
import { TerminalsScreen } from "./Terminals";


type Page = "agents" | "terminals" | "files" | "actions";

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
  useViewportHeight();

  useEffect(() => {
    void start();
  }, []);

  function open(ptyId: string) {
    setLastOpened(ptyId);
    setOpenPty(ptyId);
  }

  // Unpaired (or mid-pairing, so a failure keeps its message on screen).
  if (remote.status === "unpaired" || remote.pairing) return <PairingScreen initialError={remote.error} />;
  if (remote.status === "loading") return <div className="screen" />;

  const tab = openPty ? remote.tabs?.find((x) => x.ptyId === openPty) : undefined;
  if (tab) {
    return (
      <>
        <Banner />
        <TerminalScreen key={tab.ptyId} tab={tab} status={remote.status} onBack={() => setOpenPty(null)} />
        <Toast />
      </>
    );
  }

  return (
    <div className="screen">
      <Banner />
      <main className="page">
        {page === "agents" && <AgentsScreen hostName={remote.hostName} tabs={remote.tabs} usage={remote.usage} onOpen={open} />}
        {page === "terminals" && (
          <TerminalsScreen
            tabs={remote.tabs}
            onOpen={open}
            onUnpair={() => {
              if (window.confirm(t("unpairConfirm"))) void unpair();
            }}
          />
        )}
        {page === "files" && <FilesScreen tabs={remote.tabs} lastOpened={remote.lastOpened} />}
        {page === "actions" && <ActionsScreen tabs={remote.tabs} actions={remote.actions} lastOpened={remote.lastOpened} />}
      </main>
      <BottomNav page={page} onChange={setPage} />
      <Toast />
    </div>
  );
}

function Banner() {
  const { status, error } = useRemote();
  if (status === "online") return null;
  return (
    <div className="banner" role="status">
      <i />
      <span>{status === "connecting" ? t("connecting") : t("offline")}</span>
      {error && status === "offline" && <small>{error}</small>}
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
    { id: "files", label: t("navFiles"), icon: <FolderIcon /> },
    { id: "actions", label: t("navActions"), icon: <BoltIcon /> },
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
