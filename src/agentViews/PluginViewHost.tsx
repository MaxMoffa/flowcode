import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../i18n";
import { useTheme } from "../themes/ThemeContext";
import { CLI_INFO } from "../agents/cliInfo";
import type { ChatEvent } from "../chat/chatTypes";
import {
  createBridgeHost,
  pluginFileUrl,
  type BridgeSource,
  type ViewPluginManifest,
  type ViewStatus,
  type ViewTheme,
} from "../../shared/agentViewBridge";
import { readTheme } from "./readTheme";
import type { AgentViewProps } from "./types";
import "./plugin-view-host.css";

/** How long a view has to say hello before it's declared unresponsive. */
const HELLO_TIMEOUT_MS = 10_000;

interface PluginViewHostProps extends AgentViewProps {
  manifest: ViewPluginManifest;
  /** Reinstall count of this view: a new value loads the page again. */
  rev?: number;
}

/** Hosts an installed agent view: the plugin's page in a sandboxed iframe
 * (no network, no access to the app), talking to the session through the
 * bridge host in shared/agentViewBridge.ts, fed here by Tauri. What matters
 * for trust is drawn here, around the iframe, where the plugin can't reach
 * it: permission requests from the agent, the "agent closed" state, a view
 * that never starts. */
export function PluginViewHost(props: PluginViewHostProps) {
  const { manifest, rev, session, agent, cwd, title, hidden, onSwitchView, onOpenFile } = props;
  const { t, language } = useI18n();
  const { theme, paletteId, contrast, glassOpacity } = useTheme();
  const { model, phase, queued, modes, chatId } = session;

  const status = phase === "failed" ? "exited" : model.status;
  const currentModeId = model.currentModeId ?? modes?.currentModeId ?? null;
  const name = manifest.labels?.[language] ?? manifest.label;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [unresponsive, setUnresponsive] = useState(false);
  // What the source below reads, so the bridge host never goes stale.
  const latest = useRef({ agent, cwd, title, session, status, currentModeId, language, theme, onSwitchView, onOpenFile });
  latest.current = { agent, cwd, title, session, status, currentModeId, language, theme, onSwitchView, onOpenFile };
  const statusListeners = useRef(new Set<(status: ViewStatus) => void>());
  const themeListeners = useRef(new Set<(theme: ViewTheme) => void>());

  // The backend routes on the path only, so the query is just a cache buster.
  const src = useMemo(() => {
    const url = pluginFileUrl(convertFileSrc(manifest.id, "flowcode-plugin"), manifest.entry);
    return rev ? `${url}?rev=${rev}` : url;
  }, [manifest.id, manifest.entry, rev]);

  const viewStatus = (): ViewStatus => ({
    status: latest.current.status,
    queued: latest.current.session.queued,
    currentModeId: latest.current.currentModeId,
  });

  useEffect(() => {
    if (!chatId) return;
    const source: BridgeSource<ChatEvent> = {
      device: "desktop",
      locale: () => latest.current.language,
      session: () => {
        const { agent, cwd, title, session } = latest.current;
        return { agent, agentLabel: CLI_INFO[agent].label, cwd, sessionId: session.sessionId ?? null, title };
      },
      modes: () => latest.current.session.modes,
      status: viewStatus,
      theme: () => readTheme(latest.current.theme),
      subscribe: (listener) =>
        listen<{ chatId: string; event: ChatEvent }>("chat-event", (e) => {
          if (e.payload.chatId === chatId) listener(e.payload.event);
        }),
      replay: () => invoke<ChatEvent[]>("chat_events", { chatId, afterSeq: 0 }),
      onStatus: (listener) => {
        statusListeners.current.add(listener);
        return () => statusListeners.current.delete(listener);
      },
      onTheme: (listener) => {
        themeListeners.current.add(listener);
        return () => themeListeners.current.delete(listener);
      },
      send: (text) => latest.current.session.send(text),
      cancel: () => latest.current.session.cancel(),
      setMode: (modeId) => latest.current.session.setMode(modeId),
      openFile: (path) => latest.current.onOpenFile(path),
      switchView: (viewId) => latest.current.onSwitchView(viewId),
    };
    const host = createBridgeHost({
      iframeWindow: () => frameRef.current?.contentWindow ?? null,
      manifest,
      source,
      onConnect: () => {
        setUnresponsive(false);
        setConnected(true);
      },
    });
    return host.dispose;
  }, [manifest, chatId]);

  useEffect(() => {
    statusListeners.current.forEach((listener) => listener(viewStatus()));
  }, [status, queued, currentModeId]);

  // Runs after the theme provider has applied the new theme to :root.
  useEffect(() => {
    themeListeners.current.forEach((listener) => listener(readTheme(theme)));
  }, [theme, paletteId, contrast, glassOpacity]);

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setUnresponsive(true), HELLO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  // The agent's open permission request, if any.
  const pending = [...model.items].reverse().find((item) => item.type === "permission" && item.resolved === undefined);
  const failed = unresponsive && !connected;

  return (
    <div className="agent-plugin" style={hidden ? { display: "none" } : undefined}>
      {pending?.type === "permission" && (
        <div className="chat-permission agent-plugin-permission" role="group" aria-label={t("chat.permission.title")}>
          <div className="chat-permission-title">{pending.toolCall.title ?? pending.toolCall.kind ?? t("chat.permission.title")}</div>
          <div className="chat-permission-options">
            {pending.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className={"chat-btn" + (option.kind === "allow_once" ? " is-primary" : "")}
                onClick={() => session.answerPermission(pending.requestId, option.optionId)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {failed && (
        <div className="chat-state agent-plugin-unresponsive">
          <div className="chat-state-title">{t("agentViews.plugin.unresponsive")}</div>
          <div>{t("agentViews.plugin.unresponsive.hint", { name })}</div>
          <div className="chat-state-actions">
            <button type="button" className="chat-btn is-primary" onClick={() => onSwitchView("chat")}>
              {t("agentViews.plugin.backToChat")}
            </button>
          </div>
        </div>
      )}
      <iframe
        ref={frameRef}
        className={"agent-plugin-frame" + (failed ? " is-hidden" : "")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        title={t("agentViews.plugin.title", { name })}
      />

      {phase === "ready" && status === "exited" && (
        <div className="chat-exited agent-plugin-exited">
          <span>{t("chat.exited")}</span>
          <button type="button" className="chat-btn is-primary" onClick={session.restart}>
            {t("chat.restart")}
          </button>
        </div>
      )}
    </div>
  );
}
