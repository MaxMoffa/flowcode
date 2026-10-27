import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "../../src/chat/chatTypes";
import { THEME_TOKENS, createBridgeHost, type BridgeSource, type ViewStatus, type ViewTheme } from "../../shared/agentViewBridge";
import type { ChatInfo, ViewPackage } from "../../shared/remote-types";
import { chatModels, chatModes, chatStatus, type ChatSession } from "./chatSession";
import { cancelChat, onNewChatEvents, rawChatEvents, sendChatPrompt, setChatMode, setChatModel } from "./chats";
import { agentName } from "./common";
import { t } from "./i18n";
import { showToast, useRemoteSelector, useSupports } from "./remote";
import { phoneTheme } from "./theme";
import { useWide } from "./wide";
import { viewLabel, viewSrc } from "./viewCache";

/** How long a view has to say hello before it's declared unresponsive. */
const HELLO_TIMEOUT_MS = 10_000;

/** The bridge's theme tokens by the phone's own variable that fills them. */
const TOKEN_SOURCES: Record<(typeof THEME_TOKENS)[number], string> = {
  "--fg": "--fg",
  "--fg-muted": "--muted",
  "--bg-elevated": "--surface-2",
  "--sidebar-hover": "--surface-3",
  "--border": "--border",
  "--accent": "--accent",
  "--accent-2": "--accent-2",
  "--danger": "--danger",
  "--warning": "--wait",
  "--info": "--busy",
  "--font-ui": "--font",
  "--font-mono": "--mono",
};

/** The app's resolved colors and fonts, as the view gets them. */
function readTheme(): ViewTheme {
  const root = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) tokens[name] = root.getPropertyValue(TOKEN_SOURCES[name]).trim();
  return { scheme: document.documentElement.dataset.theme === "light" ? "light" : "dark", tokens };
}

/** The bottom inset of the screen, where Android hands it over (the header already covers the top). */
function bottomInset(): number {
  return parseFloat(document.documentElement.style.getPropertyValue("--inset-b")) || 0;
}

/**
 * Hosts a cached agent view plugin: its page in a sandboxed iframe (no network,
 * no access to the app) talking to the session through the bridge host of
 * shared/agentViewBridge.ts, fed here by the chat store. Nothing a view can
 * send answers a permission prompt; that stays with the app's own bar, drawn
 * by ChatScreen around this. A view that never says hello is declared
 * unresponsive and the user is offered the chat back.
 */
export function ChatPluginView({ pkg, info, session, onSwitchView }: { pkg: ViewPackage; info: ChatInfo; session: ChatSession; onSwitchView: (viewId: string) => void }) {
  const language = useRemoteSelector((s) => s.settings?.resolvedLanguage);
  const settings = useRemoteSelector((s) => s.settings);
  const local = phoneTheme.use();
  const wide = useWide();
  const name = viewLabel(pkg, language);
  const { chatId } = info;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [unresponsive, setUnresponsive] = useState(false);
  const status = chatStatus(info, session.model);
  const currentModeId = session.model.currentModeId ?? chatModes(info, session.model)?.currentModeId ?? null;
  // A desktop that can't switch models offers the view no choice.
  const canSetModel = useSupports("chatModel");
  const currentModelId = canSetModel ? (chatModels(info, session.model)?.currentModelId ?? null) : null;
  // What the source below reads, so the bridge host never goes stale.
  const latest = useRef({ info, session, language, wide, onSwitchView, canSetModel });
  latest.current = { info, session, language, wide, onSwitchView, canSetModel };
  const statusListeners = useRef(new Set<(status: ViewStatus) => void>());
  const themeListeners = useRef(new Set<(theme: ViewTheme) => void>());
  const src = useMemo(() => viewSrc(pkg), [pkg]);

  const viewStatus = (): ViewStatus => ({
    status: chatStatus(latest.current.info, latest.current.session.model),
    queued: latest.current.session.queued,
    currentModeId: latest.current.session.model.currentModeId ?? chatModes(latest.current.info, latest.current.session.model)?.currentModeId ?? null,
    currentModelId: latest.current.canSetModel ? (chatModels(latest.current.info, latest.current.session.model)?.currentModelId ?? null) : null,
  });

  useEffect(() => {
    const bottom = bottomInset();
    const source: BridgeSource<ChatEvent> = {
      device: latest.current.wide ? "tablet" : "phone",
      insets: bottom > 0 ? { top: 0, right: 0, bottom, left: 0 } : undefined,
      locale: () => latest.current.language ?? "en",
      session: () => {
        const { info } = latest.current;
        return { agent: info.agent, agentLabel: agentName(info.agent), cwd: info.cwd, sessionId: info.sessionId ?? null, title: info.label };
      },
      modes: () => chatModes(latest.current.info, latest.current.session.model),
      models: () => (latest.current.canSetModel ? chatModels(latest.current.info, latest.current.session.model) : null),
      status: viewStatus,
      theme: readTheme,
      subscribe: async (listener) => onNewChatEvents(chatId, listener),
      replay: async () => rawChatEvents(chatId),
      onStatus: (listener) => {
        statusListeners.current.add(listener);
        return () => statusListeners.current.delete(listener);
      },
      onTheme: (listener) => {
        themeListeners.current.add(listener);
        return () => themeListeners.current.delete(listener);
      },
      send: (text) => sendChatPrompt(chatId, text),
      cancel: () => cancelChat(chatId),
      setMode: (modeId) => setChatMode(chatId, modeId),
      setModel: (modelId) => setChatModel(chatId, modelId),
      // The phone has no file viewer for a chat's folder (its viewer needs a terminal): say so rather than ignore it.
      openFile: () => showToast(t("chatOpenFileUnavailable")),
      switchView: (viewId) => latest.current.onSwitchView(viewId),
    };
    const host = createBridgeHost({
      iframeWindow: () => frameRef.current?.contentWindow ?? null,
      manifest: pkg,
      source,
      onConnect: () => {
        setUnresponsive(false);
        setConnected(true);
      },
    });
    return host.dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, chatId]);

  useEffect(() => {
    statusListeners.current.forEach((listener) => listener(viewStatus()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session.queued, currentModeId, currentModelId]);

  // Runs after App has applied the new colors to <html>.
  useEffect(() => {
    themeListeners.current.forEach((listener) => listener(readTheme()));
  }, [settings, local]);

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setUnresponsive(true), HELLO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const failed = unresponsive && !connected;
  return (
    <div className="chat-plugin">
      {failed && (
        <div className="chat-plugin-failed" role="alert">
          <b>{t("chatViewUnresponsive")}</b>
          <span>{t("chatViewUnresponsiveHint", { name })}</span>
          <button type="button" className="btn primary" onClick={() => onSwitchView("chat")}>
            {t("chatBackToChat")}
          </button>
        </div>
      )}
      <iframe ref={frameRef} className={"chat-plugin-frame" + (failed ? " is-hidden" : "")} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} title={t("chatViewTitle", { name })} />
    </div>
  );
}
