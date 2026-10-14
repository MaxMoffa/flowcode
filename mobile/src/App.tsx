import { Component, Suspense, lazy, useEffect, useLayoutEffect, useState, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { AgentsScreen } from "./Agents";
import { tapFeedback } from "./haptics";
import { AgentsIcon, SlidersIcon, TerminalIcon } from "./icons";
import { t } from "./i18n";
import { LockScreen } from "./Lock";
import { unlock, useLock } from "./applock";
import { useBackHandler } from "./back";
import { PairingScreen } from "./Pairing";
import { Reconnect } from "./Reconnect";
import { clearOpenTab, resetSettingsCache, setBackgroundTexts, setLastOpened, start, useRemote, useRemoteSelector } from "./remote";
import { TerminalsScreen } from "./Terminals";
import { applyTheme, phoneTheme, withPhoneTheme } from "./theme";

// xterm makes the terminal the bulk of the bundle; it loads when first opened.
const TerminalScreen = lazy(() => import("./TerminalScreen").then((m) => ({ default: m.TerminalScreen })));
const SettingsScreen = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsScreen })));

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

/** Bad cached or incoming data must not brick the app: offer to drop the cached settings. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <h1>{t("errorTitle")}</h1>
        <button
          type="button"
          className="btn primary big"
          onClick={() => {
            resetSettingsCache();
            this.setState({ failed: false });
          }}
        >
          {t("errorReset")}
        </button>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const remote = useRemote();
  const [page, setPage] = useState<Page>("agents");
  const [openPty, setOpenPty] = useState<string | null>(null);
  const lock = useLock();
  useViewportHeight();

  // The phone wears the desktop's colors and language (see remote.ts); before
  // the first settings message the cached ones (or the defaults) apply.
  const localTheme = phoneTheme.use();
  useLayoutEffect(() => applyTheme(withPhoneTheme(remote.settings, localTheme)), [remote.settings, localTheme]);

  useEffect(() => {
    void start();
  }, []);

  // A phone that wasn't paired at launch has nothing to lock yet: the lock must not appear right after the first pairing.
  useEffect(() => {
    if (remote.status === "unpaired" && lock.locked) unlock();
  }, [remote.status, lock.locked]);

  // A fresh pairing starts on the agents list, not wherever the last one ended.
  useEffect(() => {
    if (remote.status === "unpaired") {
      setPage("agents");
      setOpenPty(null);
    }
  }, [remote.status]);

  // The permanent notification of the background mode names the desktop.
  useEffect(() => {
    if (remote.hostName) void setBackgroundTexts(t("bgNotifTitle"), t("bgNotifText", { host: remote.hostName }));
  }, [remote.hostName, remote.settings?.resolvedLanguage]);

  // A tapped agent notification opens that tab's terminal as soon as the list has it.
  useEffect(() => {
    if (!remote.openTab || !remote.tabs) return;
    const target = remote.tabs.find((x) => x.tabId === remote.openTab);
    if (!target) return;
    setLastOpened(target.ptyId);
    setOpenPty(target.ptyId);
    clearOpenTab();
  }, [remote.openTab, remote.tabs]);

  const tab = openPty ? remote.tabs?.find((x) => x.ptyId === openPty) : undefined;
  // The open terminal was closed on the PC: forget it, or the screen would come back if the id ever reappears.
  useEffect(() => {
    if (openPty && remote.tabs && !tab) setOpenPty(null);
  }, [openPty, remote.tabs, tab]);
  // Back from a terminal returns to the list; on the root it is left alone (the app exits).
  useBackHandler(!!tab, () => setOpenPty(null));

  function open(ptyId: string) {
    setLastOpened(ptyId);
    setOpenPty(ptyId);
  }

  const paired = remote.status !== "unpaired" && remote.status !== "loading";
  let content: ReactNode;
  if (!lock.checked) {
    // Avoids a flash of content before the first lock probe.
    content = <div className="screen" />;
  } else if (lock.locked && paired) {
    // Locked: nothing else renders, so no content ends up in the task switcher thumbnail.
    content = <LockScreen />;
  } else if (remote.status === "unpaired" || remote.pairing) {
    // Unpaired (or mid-pairing, so a failure keeps its message on screen).
    content = <PairingScreen initialError={remote.error} />;
  } else if (remote.status === "loading") {
    content = <div className="screen" />;
  } else if (tab) {
    content = (
      <Suspense fallback={<div className="screen" />}>
        <TerminalScreen key={tab.ptyId} tab={tab} status={remote.status} onBack={() => setOpenPty(null)} />
      </Suspense>
    );
  } else {
    content = (
      <div className="screen">
        <main className="page">
          {page === "agents" && <AgentsScreen hostName={remote.hostName} tabs={remote.tabs} usage={remote.usage} onOpen={open} />}
          {page === "terminals" && <TerminalsScreen hostName={remote.hostName} tabs={remote.tabs} onOpen={open} />}
          {page === "settings" && (
            <Suspense fallback={null}>
              <SettingsScreen hostName={remote.hostName} settings={remote.settings} profiles={remote.profiles} />
            </Suspense>
          )}
        </main>
        <BottomNav page={page} onChange={setPage} />
      </div>
    );
  }

  // Reconnect and Toast sit at fixed positions beside the screen, so switching
  // between the list and a terminal never remounts them.
  return (
    <>
      {content}
      {paired && !remote.pairing && !remote.firstConnect && <Reconnect />}
      <Toast />
      {lock.hidden && <div className="privacy" aria-hidden="true" />}
    </>
  );
}

function Toast() {
  const toast = useRemoteSelector((s) => s.toast);
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
    <nav className="nav" aria-label={t("navMain")}>
      {items.map((it) => (
        <button key={it.id} type="button" className={page === it.id ? "on" : ""} aria-current={page === it.id ? "page" : undefined} onClick={() => {
            tapFeedback();
            onChange(it.id);
          }}>
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
