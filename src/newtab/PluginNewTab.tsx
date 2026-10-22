import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { useTheme } from "../themes/ThemeContext";
import { CLI_INFO } from "../agents/cliInfo";
import { useAvailableClis } from "../agents/useAvailableClis";
import { listFavorites, subscribeFavorites } from "../favorites/favoritesStore";
import { useProfiles } from "../profiles/profiles";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { readTheme } from "../agentViews/readTheme";
import { pluginFileUrl, type ViewTheme } from "../../shared/agentViewBridge";
import { createNewTabBridgeHost, type NewTabData, type NewTabPluginManifest } from "../../shared/newTabBridge";
import { DEFAULT_NEW_TAB_LAYOUT } from "./layouts";
import { setNewTabSettings } from "./newTabSettings";
import { buildNewTabData, resolveNewTabLaunch, type NewTabLists } from "./pluginData";
import { listRecentTerminals, subscribeRecentTerminals } from "./recentTerminals";
import { shellChips } from "./shellChips";
import type { NewTabLayoutProps } from "./types";
import "./plugin-new-tab.css";

/** How long a page has to say hello before it's declared unresponsive. */
const HELLO_TIMEOUT_MS = 10_000;

interface PluginNewTabProps extends NewTabLayoutProps {
  manifest: NewTabPluginManifest;
  /** Reinstall count of this layout: a new value loads the page again. */
  rev?: number;
}

/** Hosts an installed new tab layout: the plugin's page in a sandboxed iframe
 * (no network, no access to the app), talking to the host only through the
 * bridge in shared/newTabBridge.ts. The page is fed the lists below and can
 * only name one of their entries to start - what is started, and how, is
 * decided here (see pluginData.ts), exactly as the built-in layouts do. */
export function PluginNewTab(props: PluginNewTabProps) {
  const { manifest, rev, hidden, defaultShell, profileId, onLaunch, onLaunchAgent, onCustomize, onDone } = props;
  const { t, language } = useI18n();
  const { theme, paletteId, contrast, glassOpacity } = useTheme();
  const { profiles } = useProfiles();
  const name = manifest.labels?.[language] ?? manifest.label;

  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const recents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals);
  const [options, setOptions] = useState<ShellOption[]>([]);
  const clis = useAvailableClis(profiles.find((p) => p.id === profileId));

  useEffect(() => {
    let cancelled = false;
    void listShellOptions().then((opts) => {
      if (!cancelled) setOptions(opts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const lists = useMemo<NewTabLists>(() => {
    const profile = profiles.find((p) => p.id === profileId);
    const { chips, chipShell } = shellChips(options, defaultShell);
    return {
      recents,
      favorites,
      shells: chips.map((opt) => ({ id: chipShell(opt), label: shellOptionLabel(opt) })),
      agents: clis.map((cli) => ({ id: cli, label: CLI_INFO[cli].label })),
      ...(profile ? { profile: { id: profile.id, label: profile.name } } : {}),
    };
  }, [recents, favorites, options, defaultShell, clis, profiles, profileId]);
  const data = useMemo(() => buildNewTabData(lists), [lists]);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [unresponsive, setUnresponsive] = useState(false);
  // What the source below reads, so the bridge host never goes stale.
  const latest = useRef({ lists, data, language, theme, defaultShell, onLaunch, onLaunchAgent, onCustomize, onDone });
  latest.current = { lists, data, language, theme, defaultShell, onLaunch, onLaunchAgent, onCustomize, onDone };
  const dataListeners = useRef(new Set<(data: NewTabData) => void>());
  const themeListeners = useRef(new Set<(theme: ViewTheme) => void>());

  // The backend routes on the path only, so the query is just a cache buster.
  const src = useMemo(() => {
    const url = pluginFileUrl(convertFileSrc(manifest.id, "flowcode-plugin"), manifest.entry);
    return rev ? `${url}?rev=${rev}` : url;
  }, [manifest.id, manifest.entry, rev]);

  useEffect(() => {
    const host = createNewTabBridgeHost({
      iframeWindow: () => frameRef.current?.contentWindow ?? null,
      manifest,
      source: {
        locale: () => latest.current.language,
        theme: () => readTheme(latest.current.theme),
        data: () => latest.current.data,
        onData: (listener) => {
          dataListeners.current.add(listener);
          return () => dataListeners.current.delete(listener);
        },
        onTheme: (listener) => {
          themeListeners.current.add(listener);
          return () => themeListeners.current.delete(listener);
        },
        launch: (kind, id) => {
          const { lists, defaultShell, onLaunch, onLaunchAgent, onDone } = latest.current;
          const resolved = resolveNewTabLaunch(lists, kind, id, defaultShell);
          if (!resolved) return;
          if ("agent" in resolved) {
            onLaunchAgent(resolved.agent);
            return;
          }
          // The page has nothing to hand over: the tab turns into the terminal at once.
          onLaunch(resolved.launch);
          onDone();
        },
        customize: () => latest.current.onCustomize(),
      },
      onConnect: () => {
        setUnresponsive(false);
        setConnected(true);
      },
    });
    return host.dispose;
  }, [manifest]);

  useEffect(() => {
    dataListeners.current.forEach((listener) => listener(data));
  }, [data]);

  // Runs after the theme provider has applied the new theme to :root.
  useEffect(() => {
    themeListeners.current.forEach((listener) => listener(readTheme(theme)));
  }, [theme, paletteId, contrast, glassOpacity]);

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setUnresponsive(true), HELLO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const failed = unresponsive && !connected;

  return (
    <div className="newtab-plugin" hidden={hidden}>
      {failed && (
        <div className="newtab-plugin-unresponsive">
          <div className="newtab-plugin-unresponsive-title">{t("newTab.plugin.unresponsive")}</div>
          <div>{t("newTab.plugin.unresponsive.hint", { name })}</div>
          <button type="button" className="newtab-plugin-button" onClick={() => setNewTabSettings({ layout: DEFAULT_NEW_TAB_LAYOUT })}>
            {t("newTab.plugin.useTerminal")}
          </button>
        </div>
      )}
      <iframe
        ref={frameRef}
        className={"newtab-plugin-frame" + (failed ? " is-hidden" : "")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        title={t("newTab.plugin.title", { name })}
      />
    </div>
  );
}
