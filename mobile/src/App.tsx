import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { AgentsScreen } from "./Agents";
import { tapFeedback } from "./haptics";
import { AgentsIcon, SlidersIcon, TerminalIcon } from "./icons";
import { t } from "./i18n";
import { LockScreen } from "./Lock";
import { unlock, useLock } from "./applock";
import { useBackHandler } from "./back";
import { PairingScreen } from "./Pairing";
import { CompatBanner, IncompatibleScreen } from "./Compat";
import { clearOpenRequest, requestOpenChat, useChatHandoff, useOpenRequest, useTerminalHandoff } from "./chats";
import { checkCompat } from "./compatCheck";
import { Reconnect } from "./Reconnect";
import { clearOpenTab, onDeepLink, resetSettingsCache, setBackgroundTexts, setLastOpened, start, takePendingLink, useRemoteSelector } from "./remote";
import { TerminalsScreen } from "./Terminals";
import { UpdateSheet } from "./UpdatesUi";
import { autoCheckForUpdates, updates } from "./updates";
// Listens for the desktop's `views` from the start, long before a chat is opened.
import "./viewCache";
import { applyTheme, phoneTheme, withPhoneTheme } from "./theme";
import { WideShell } from "./WideShell";
import { useWide } from "./wide";

// xterm makes the terminal the bulk of the bundle; it loads when first opened.
const TerminalScreen = lazy(() => import("./TerminalScreen").then((m) => ({ default: m.TerminalScreen })));
const SettingsScreen = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsScreen })));
const ChatScreen = lazy(() => import("./ChatScreen").then((m) => ({ default: m.ChatScreen })));

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

/** Android's WebView under-reports env(safe-area-inset-*) edge-to-edge; MainActivity.kt hands over the system bar insets instead. */
function useSystemInsets() {
  useEffect(() => {
    const bridge = (window as { FlowcodeInsets?: { get(): string } }).FlowcodeInsets;
    if (!bridge) return;
    const apply = () => {
      const raw = bridge.get();
      if (!raw) return;
      const [top, bottom] = raw.split(",").map(Number);
      const root = document.documentElement.style;
      root.setProperty("--inset-t", `${top}px`);
      root.setProperty("--inset-b", `${bottom}px`);
    };
    apply();
    window.addEventListener("flowcode-insets", apply);
    return () => window.removeEventListener("flowcode-insets", apply);
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
  const chats = useRemoteSelector((s) => s.chats);
  const openTab = useRemoteSelector((s) => s.openTab);
  const error = useRemoteSelector((s) => s.error);
  const host = useRemoteSelector((s) => s.host);
  const compatDismissed = useRemoteSelector((s) => s.compatDismissed);
  const compat = checkCompat(host);
  const [page, setPage] = useState<Page>("agents");
  const [openPty, setOpenPty] = useState<string | null>(null);
  /** The chat session shown instead of a terminal. */
  const [openChat, setOpenChat] = useState<string | null>(null);
  const openRequest = useOpenRequest();
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
  useSystemInsets();
  const wide = useWide();

  // The phone wears the desktop's colors and language (see remote.ts); before
  // the first settings message the cached ones (or the defaults) apply.
  const localTheme = phoneTheme.use();
  useLayoutEffect(() => applyTheme(withPhoneTheme(settings, localTheme)), [settings, localTheme]);

  useEffect(() => {
    void start();
  }, []);

  // Look for a newer app a few seconds after start (and when the app comes
  // back after hours), once there is a paired, unlocked screen to show it on.
  const update = updates.use();
  const updatesReady = paired && lock.checked && !lock.locked;
  useEffect(() => {
    if (!updatesReady) return;
    const timer = setTimeout(autoCheckForUpdates, 4000);
    const onVisible = () => document.visibilityState === "visible" && autoCheckForUpdates();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [updatesReady]);

  // A phone that wasn't paired at launch has nothing to lock yet: the lock must not appear right after the first pairing.
  useEffect(() => {
    if (status === "unpaired" && lock.locked) unlock();
  }, [status, lock.locked]);

  // A fresh pairing starts on the agents list, not wherever the last one ended.
  useEffect(() => {
    if (status === "unpaired") {
      setPage("agents");
      setOpenPty(null);
      setOpenChat(null);
      closeAdding();
    }
  }, [status, closeAdding]);

  // A pairing link while a computer is already paired: add that one too.
  useEffect(() => {
    if (!paired || adding) return;
    const fromLink = (url: string) => {
      if (!window.confirm(t("addComputerFromLink"))) return;
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

  // A tapped agent notification opens that tab's terminal (or chat) as soon as the lists have it.
  useEffect(() => {
    if (!openTab || !tabs) return;
    const target = tabs.find((x) => x.tabId === openTab);
    const chat = target ? undefined : chats?.find((c) => c.tabId === openTab);
    if (target) open(target.ptyId);
    else if (chat) openChatTab(chat.chatId);
    else return;
    clearOpenTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab, tabs, chats]);

  // A list far from here asked for a chat.
  useEffect(() => {
    if (!openRequest) return;
    openChatTab(openRequest);
    clearOpenRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  const tab = openPty ? tabs?.find((x) => x.ptyId === openPty) : undefined;
  // The open terminal was closed on the PC: forget it, or the screen would come back if the id ever reappears.
  useEffect(() => {
    if (openPty && tabs && !tab) setOpenPty(null);
  }, [openPty, tabs, tab]);
  // The open chat left the desktop (closed, or turned into a terminal): back to the list.
  const chat = openChat ? chats?.find((c) => c.chatId === openChat) : undefined;
  useEffect(() => {
    if (openChat && chats && !chat) setOpenChat(null);
  }, [openChat, chats, chat]);
  // Back from a terminal or a chat returns to the list; on the root it is left alone (the app exits).
  useBackHandler((!!tab || !!chat) && !wide, () => {
    setOpenPty(null);
    setOpenChat(null);
  });

  function open(ptyId: string) {
    setLastOpened(ptyId);
    setOpenChat(null);
    setOpenPty(ptyId);
  }

  function openChatTab(chatId: string) {
    setOpenPty(null);
    setOpenChat(chatId);
  }

  /** "Terminale" in a chat: the desktop turns the session into a terminal tab, which opens once listed. */
  const toTerminal = useChatHandoff(tabs, open);
  /** A plugin view picked in a terminal: the desktop turns the agent into a chat, which opens once listed. */
  const toChat = useTerminalHandoff(chats, openChatTab);

  // The wide layout always shows something: pick the first terminal (else chat) when nothing is open.
  useEffect(() => {
    if (!wide || openChat) return;
    if (tabs && tabs.length > 0 && !(openPty && tabs.some((x) => x.ptyId === openPty))) open(tabs[0].ptyId);
    else if (tabs && tabs.length === 0 && chats && chats.length > 0) requestOpenChat(chats[0].chatId);
  });

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
  } else if (compat.level === "blocked" && host) {
    content = <IncompatibleScreen host={host} hostName={hostName} />;
  } else if (wide) {
    content = (
      <WideShell hostName={hostName} tabs={tabs} settings={settings} status={status} activePty={openPty} onSelectPty={open} activeChat={openChat} onTerminal={toTerminal} onAddComputer={() => setAdding(true)} />
    );
  } else if (chat) {
    content = (
      <Suspense fallback={<div className="screen" />}>
        <ChatScreen key={chat.chatId} chatId={chat.chatId} onBack={() => setOpenChat(null)} onTerminal={toTerminal} onSwitch={open} />
      </Suspense>
    );
  } else if (tab) {
    content = (
      <Suspense fallback={<div className="screen" />}>
        <TerminalScreen key={tab.ptyId} tab={tab} status={status} onBack={() => setOpenPty(null)} onSwitch={open} onChat={toChat} />
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
        <BottomNav page={page} onChange={setPage} updateAvailable={!!update.info} />
      </div>
    );
  }

  // Reconnect and Toast sit at fixed positions beside the screen, so switching
  // between the list and a terminal never remounts them.
  return (
    <>
      {content}
      {compat.level === "partial" && host && !compatDismissed && paired && !adding && !lock.locked && <CompatBanner host={host} hostName={hostName} />}
      {paired && !pairing && !firstConnect && !adding && <Reconnect />}
      {update.sheetPending && updatesReady && !pairing && !adding && compat.level !== "blocked" && <UpdateSheet />}
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

function BottomNav({ page, onChange, updateAvailable }: { page: Page; onChange: (p: Page) => void; updateAvailable: boolean }) {
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
          {it.id === "settings" && updateAvailable && <i className="nav-dot" aria-label={t("updSheetTitle")} />}
        </button>
      ))}
    </nav>
  );
}
