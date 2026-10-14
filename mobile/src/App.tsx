import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { AgentsScreen } from "./Agents";
import { tapFeedback } from "./haptics";
import { AgentsIcon, SlidersIcon, TerminalIcon } from "./icons";
import { t } from "./i18n";
import { LockScreen } from "./Lock";
import { unlock, useLock } from "./applock";
import { useBackHandler } from "./back";
import { PairingScreen } from "./Pairing";
import { Reconnect } from "./Reconnect";
import { clearOpenTab, onDeepLink, resetSettingsCache, setBackgroundTexts, setLastOpened, start, takePendingLink, useRemoteSelector } from "./remote";
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
  const status = useRemoteSelector((s) => s.status);
  const pairing = useRemoteSelector((s) => s.pairing);
  const firstConnect = useRemoteSelector((s) => s.firstConnect);
  const hostName = useRemoteSelector((s) => s.hostName);
  const settings = useRemoteSelector((s) => s.settings);
  const tabs = useRemoteSelector((s) => s.tabs);
  const openTab = useRemoteSelector((s) => s.openTab);
  const error = useRemoteSelector((s) => s.error);
  const [page, setPage] = useState<Page>("agents");
  const [openPty, setOpenPty] = useState<string | null>(null);
  /** Adding another computer: the pairing screen over a paired phone, with the link that opened it if any. */
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const closeAdding = useCallback(() => {
    setAdding(false);
    setLink(null);
  }, []);
  const paired = status !== "unpaired" && status !== "loading";
  const lock = useLock();
  useViewportHeight();

  // The phone wears the desktop's colors and language (see remote.ts); before
  // the first settings message the cached ones (or the defaults) apply.
  const localTheme = phoneTheme.use();
  useLayoutEffect(() => applyTheme(withPhoneTheme(settings, localTheme)), [settings, localTheme]);

  useEffect(() => {
    void start();
  }, []);

  // A phone that wasn't paired at launch has nothing to lock yet: the lock must not appear right after the first pairing.
  useEffect(() => {
    if (status === "unpaired" && lock.locked) unlock();
  }, [status, lock.locked]);

  // A fresh pairing starts on the agents list, not wherever the last one ended.
  useEffect(() => {
    if (status === "unpaired") {
      setPage("agents");
      setOpenPty(null);
      closeAdding();
    }
  }, [status, closeAdding]);

  // A pairing link while a computer is already paired: add that one too.
  useEffect(() => {
    if (!paired || adding) return;
    const fromLink = (url: string) => {
      setLink(url);
      setAdding(true);
    };
    void takePendingLink().then((url) => url && fromLink(url));
    const off = onDeepLink(fromLink);
    return () => void off.then((f) => f());
  }, [paired, adding]);
  useBackHandler(adding, closeAdding);

  // The permanent notification of the background mode names the desktop.
  useEffect(() => {
    if (hostName) void setBackgroundTexts(t("bgNotifTitle"), t("bgNotifText", { host: hostName }));
  }, [hostName, settings?.resolvedLanguage]);

  // A tapped agent notification opens that tab's terminal as soon as the list has it.
  useEffect(() => {
    if (!openTab || !tabs) return;
    const target = tabs.find((x) => x.tabId === openTab);
    if (!target) return;
    setLastOpened(target.ptyId);
    setOpenPty(target.ptyId);
    clearOpenTab();
  }, [openTab, tabs]);

  const tab = openPty ? tabs?.find((x) => x.ptyId === openPty) : undefined;
  // The open terminal was closed on the PC: forget it, or the screen would come back if the id ever reappears.
  useEffect(() => {
    if (openPty && tabs && !tab) setOpenPty(null);
  }, [openPty, tabs, tab]);
  // Back from a terminal returns to the list; on the root it is left alone (the app exits).
  useBackHandler(!!tab, () => setOpenPty(null));

  function open(ptyId: string) {
    setLastOpened(ptyId);
    setOpenPty(ptyId);
  }

  let content: ReactNode;
  if (!lock.checked) {
    // Avoids a flash of content before the first lock probe.
    content = <div className="screen" />;
  } else if (lock.locked && paired) {
    // Locked: nothing else renders, so no content ends up in the task switcher thumbnail.
    content = <LockScreen />;
  } else if (status === "unpaired" || pairing || adding) {
    // Unpaired, adding another computer, or mid-pairing (so a failure keeps its message on screen).
    content = <PairingScreen initialError={adding ? undefined : error} initialLink={link} onClose={adding ? closeAdding : undefined} />;
  } else if (status === "loading") {
    content = <div className="screen" />;
  } else if (tab) {
    content = (
      <Suspense fallback={<div className="screen" />}>
        <TerminalScreen key={tab.ptyId} tab={tab} status={status} onBack={() => setOpenPty(null)} />
      </Suspense>
    );
  } else {
    content = (
      <div className="screen">
        <main className="page">
          {page === "agents" && <AgentsScreen hostName={hostName} tabs={tabs} onOpen={open} onAddComputer={() => setAdding(true)} />}
          {page === "terminals" && <TerminalsScreen hostName={hostName} tabs={tabs} onOpen={open} />}
          {page === "settings" && (
            <Suspense fallback={null}>
              <SettingsScreen hostName={hostName} settings={settings} />
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
      {paired && !pairing && !firstConnect && !adding && <Reconnect />}
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
