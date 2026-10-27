import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { t, useI18n } from "../i18n";
import { useTheme } from "../themes/ThemeContext";
import { findPalette, resolveTerminalPalette } from "../themes/palettes";
import { readTermColors } from "../terminal/termColors";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useOpenLink } from "../terminal/useOpenLink";
import { onHostMessages, sendToHost, setFrontRemoteTerminal, useHost, type RemoteTerminalHandle } from "./remoteHosts";
import "@xterm/xterm/css/xterm.css";
import "../terminal/terminal.css";
import "./remote-hosts.css";

/** The pty is told the new grid only once it settles (a drag fires many sizes). */
const RESIZE_DEBOUNCE_MS = 150;
/** onData this soon after a keystroke counts as typed, even while output is being parsed. */
const USER_INPUT_WINDOW_MS = 60;

interface RemoteTerminalViewProps {
  hostId: string;
  ptyId: string;
  /** This terminal is the one in front (its host and its tab). Out of sight it stops streaming. */
  visible: boolean;
}

/** A terminal of another PC: the same screen as there, typed into from here. */
export function RemoteTerminalView({ hostId, ptyId, visible }: RemoteTerminalViewProps) {
  useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const syncRef = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  const { show } = useContextMenu();
  const { theme, paletteId, terminalPaletteId, contrast } = useTheme();
  const terminalPalette = terminalPaletteId ? findPalette(terminalPaletteId) : undefined;
  const { fontSize } = useTerminalSettings();
  const online = useHost(hostId)?.status === "online";
  const wantOpen = visible && online;
  const wantOpenRef = useRef(wantOpen);
  wantOpenRef.current = wantOpen;
  const openLink = useOpenLink();
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  // What the app's copy / paste / clear shortcuts do while this terminal is the one on screen.
  const handle = useMemo<RemoteTerminalHandle>(
    () => ({
      copySelection: () => {
        const selection = termRef.current?.getSelection();
        if (selection) navigator.clipboard.writeText(selection).catch(() => {});
      },
      paste: () => {
        navigator.clipboard
          .readText()
          .then((text) => text && termRef.current?.paste(text))
          .catch(() => {});
      },
      clear: () => termRef.current?.clear(),
    }),
    [],
  );
  useEffect(() => {
    setFrontRemoteTerminal(handle, visible);
    return () => setFrontRemoteTerminal(handle, false);
  }, [handle, visible]);

  useEffect(() => {
    const container = containerRef.current;
    const el = hostRef.current;
    if (!container || !el) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize,
      fontFamily: "Menlo, Consolas, monospace",
      theme: readTermColors(container),
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // OSC 8 hyperlinks: http(s) only, through the app's own link menu - never xterm's default confirm() + window.open.
    term.options.linkHandler = { activate: (event, uri) => openLinkRef.current(event, uri) };
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let resizeTimer = 0;

    // Same keys as the local terminal: Ctrl+V pastes natively, Ctrl+C copies a selection.
    term.attachCustomKeyEventHandler((e) => {
      const key = e.key.toLowerCase();
      const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      if ((ctrlOnly && key === "v") || (e.key === "Insert" && e.shiftKey && !e.ctrlKey)) return false;
      if (ctrlOnly && key === "c" && term.hasSelection()) {
        if (e.type === "keydown") {
          e.preventDefault();
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
        }
        return false;
      }
      return true;
    });

    const measured = () => container.clientWidth > 0 && container.clientHeight > 0;
    const send = () => {
      if (openedRef.current) void sendToHost(hostId, { t: "resize", ptyId, cols: term.cols, rows: term.rows });
    };
    // Fits to the area, and tells the pty once the size settles.
    const refit = () => {
      if (disposed || !measured()) return;
      const { cols, rows } = term;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== cols || term.rows !== rows) {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(send, RESIZE_DEBOUNCE_MS);
      }
    };
    // Opens or closes the stream so it matches whether anybody is looking.
    const sync = () => {
      if (disposed) return;
      if (wantOpenRef.current && !openedRef.current) {
        if (!measured()) return;
        refit();
        openedRef.current = true;
        void sendToHost(hostId, { t: "open", ptyId, cols: term.cols, rows: term.rows });
      } else if (!wantOpenRef.current && openedRef.current) {
        openedRef.current = false;
        void sendToHost(hostId, { t: "close", ptyId });
      }
    };
    syncRef.current = sync;

    // While remote output is parsed xterm may answer terminal queries (device
    // attributes, cursor position...). The other PC's own terminal already
    // answered them, so a second reply would reach the shell as junk: drop
    // onData emitted during a write, unless the user is typing right now.
    let writing = 0;
    let userUntil = 0;
    const markUser = () => {
      userUntil = performance.now() + USER_INPUT_WINDOW_MS;
    };
    const ta = term.textarea;
    const userEvents = ["keydown", "keypress", "input", "paste", "compositionend"] as const;
    userEvents.forEach((n) => ta?.addEventListener(n, markUser, true));
    const write = (d: string) => {
      writing++;
      term.write(d, () => {
        writing--;
      });
    };
    const data = term.onData((d) => {
      if (writing > 0 && performance.now() > userUntil) return;
      if (openedRef.current) void sendToHost(hostId, { t: "input", ptyId, data: d });
    });

    const ro = new ResizeObserver(() => {
      refit();
      sync();
    });
    ro.observe(container);

    // A snapshot replaces the screen: reset only once writes queued before it are applied, and hold the output that arrives meanwhile so it lands after.
    let held: string[] | null = null;
    let snapGen = 0;
    const off = onHostMessages(hostId, (msgs) => {
      for (const m of msgs) {
        if (m.t === "snapshot" && m.ptyId === ptyId) {
          const gen = ++snapGen;
          const held0: string[] = (held = []);
          term.write("", () => {
            if (disposed || gen !== snapGen) return;
            term.reset();
            write(m.data);
            held = null;
            held0.forEach(write);
            setEnded(false);
          });
        } else if (m.t === "output" && m.ptyId === ptyId) {
          if (held) held.push(m.data);
          else write(m.data);
        } else if (m.t === "exit" && m.ptyId === ptyId) {
          setEnded(true);
        }
      }
    });

    sync();
    return () => {
      disposed = true;
      off();
      data.dispose();
      userEvents.forEach((n) => ta?.removeEventListener(n, markUser, true));
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      syncRef.current = () => {};
      if (openedRef.current) void sendToHost(hostId, { t: "close", ptyId });
      openedRef.current = false;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, ptyId]);

  // In or out of sight, or the link coming back (the server forgot its streams then): open or close, and take focus when shown.
  useEffect(() => {
    if (!online) openedRef.current = false;
    const id = requestAnimationFrame(() => {
      if (visible) {
        try {
          if (containerRef.current && containerRef.current.clientWidth > 0) fitRef.current?.fit();
        } catch {
          /* not laid out yet */
        }
      }
      syncRef.current();
      if (wantOpen) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [wantOpen, visible, online]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    if (visible && containerRef.current && containerRef.current.clientWidth > 0) fitRef.current?.fit();
  }, [fontSize, visible]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (termRef.current && containerRef.current) termRef.current.options.theme = readTermColors(containerRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, paletteId, terminalPaletteId, contrast]);

  return (
    <div
      ref={containerRef}
      className="terminal-container remote-terminal"
      style={{ display: visible ? "flex" : "none", ...(terminalPalette ? (resolveTerminalPalette(terminalPalette, theme, contrast) as CSSProperties) : null) }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        show(e.clientX, e.clientY, [
          {
            label: t("edit.copy"),
            icon: MenuIcons.duplicate,
            disabled: !term?.hasSelection(),
            onSelect: () => {
              const selection = term?.getSelection();
              if (selection) navigator.clipboard.writeText(selection).catch(() => {});
              term?.clearSelection();
            },
          },
          {
            label: t("edit.paste"),
            icon: MenuIcons.paste,
            onSelect: () => {
              navigator.clipboard
                .readText()
                .then((text) => text && term?.paste(text))
                .catch(() => {});
            },
          },
        ]);
      }}
    >
      <div ref={hostRef} className="terminal-host" />
      {ended && <div className="remote-terminal-ended">{t("remoteHosts.terminalClosed")}</div>}
    </div>
  );
}
