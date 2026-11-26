import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TERMINAL_FONT } from "../terminal/terminalFont";
import { Terminal as XTerm } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinkResolverContext, useOpenPath, usePathMenu, type PathTarget } from "../lib/fileLinks";
import { createPathLinkProvider } from "../terminal/pathLinkProvider";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { t, useI18n } from "../i18n";
import { useTheme } from "../themes/ThemeContext";
import { findPalette, resolveTerminalPalette } from "../themes/palettes";
import { readTermColors } from "../terminal/termColors";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useLinkMenu, useOpenLink } from "../terminal/useOpenLink";
import { onHostMessages, sendToHost, setFrontRemoteTerminal, useHost, useHostLink, type RemoteTerminalHandle } from "./remoteHosts";
import "@xterm/xterm/css/xterm.css";
import "../terminal/terminal.css";
import "./remote-hosts.css";

/** The biggest grid taken from the host (a sanity bound on what the wire says). */
const MAX_COLS = 1000;
const MAX_ROWS = 500;
/** onData this soon after a keystroke counts as typed, even while output is being parsed. */
const USER_INPUT_WINDOW_MS = 60;

interface RemoteTerminalViewProps {
  hostId: string;
  ptyId: string;
  /** This terminal is the one in front (its host and its tab). Out of sight it stops streaming. */
  visible: boolean;
  /** The folder the terminal was opened in: relative paths in its output resolve against it. */
  cwd?: string;
}

/** A terminal of another PC: the same screen as there, typed into from here. This PC never imposes its size: the grid is the host's
 * (its snapshot and `resized` messages), drawn top-left and scrolled when it is bigger than the view. */
export function RemoteTerminalView({ hostId, ptyId, visible, cwd }: RemoteTerminalViewProps) {
  useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const openedRef = useRef(false);
  const syncRef = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  const { show } = useContextMenu();
  const { theme, paletteId, terminalPaletteId, contrast } = useTheme();
  const terminalPalette = terminalPaletteId ? findPalette(terminalPaletteId) : undefined;
  const { fontSize } = useTerminalSettings();
  const online = useHost(hostId)?.status === "online";
  const link = useHostLink(hostId);
  const linkRef = useRef(link);
  const wasVisible = useRef(false);
  const wantOpen = visible && online;
  const wantOpenRef = useRef(wantOpen);
  wantOpenRef.current = wantOpen;
  const openLink = useOpenLink();
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  // Paths in the output: found as in a local terminal, but the other PC's disk says whether they exist (the resolver of RemoteLinks), and a click opens its read-only viewer.
  const resolver = useContext(FileLinkResolverContext);
  const resolverRef = useRef(resolver);
  resolverRef.current = resolver;
  const cwdRef = useRef(cwd ?? null);
  cwdRef.current = cwd ?? null;
  const openPath = useOpenPath();
  // The link under the pointer: a right click on it opens its menu (as in a local terminal).
  const hoverLinkRef = useRef<{ uri: string } | { target: PathTarget; line?: number } | null>(null);
  const linkMenu = useLinkMenu();
  const pathMenu = usePathMenu();
  const pathClickRef = useRef<(event: MouseEvent, target: PathTarget, line?: number) => void>(() => {});
  pathClickRef.current = (event, target, line) => {
    if (event.button === 0) openPath(event, target, line);
  };
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
      fontFamily: TERMINAL_FONT,
      theme: readTermColors(container),
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
    });
    // OSC 8 hyperlinks: http(s) only, through the app's own link menu - never xterm's default confirm() + window.open.
    const hoverUri = { hover: (_e: MouseEvent, uri: string) => (hoverLinkRef.current = { uri }), leave: () => (hoverLinkRef.current = null) };
    term.options.linkHandler = { activate: (event, uri) => openLinkRef.current(event, uri), ...hoverUri };
    // Plain addresses in the text (its dev servers go through the tunnel, see LinkRewriteContext); only the left button opens them.
    term.loadAddon(new WebLinksAddon((event, uri) => event.button === 0 && openLinkRef.current(event, uri), hoverUri));
    term.registerLinkProvider(
      createPathLinkProvider(
        () => term.buffer.active,
        (path) => resolverRef.current?.(path, cwdRef.current) ?? Promise.resolve(null),
        (event, target, line) => pathClickRef.current(event, target, line),
        (hit) => (hoverLinkRef.current = hit),
      ),
    );
    term.open(el);
    // Right click = our menu only, never also a mouse event to an app capturing the mouse (see Terminal.tsx).
    const keepRightClick = (e: MouseEvent) => {
      if (e.button === 2 && term.modes.mouseTrackingMode !== "none") e.stopPropagation();
    };
    el.addEventListener("mousedown", keepRightClick, true);
    el.addEventListener("mouseup", keepRightClick, true);
    termRef.current = term;
    let disposed = false;

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
    // The grid is the host's. The box takes the pixel size xterm gives its screen (CSS: max-content in remote-hosts.css),
    // scrolled when bigger than the view, top-left when smaller: nothing to measure here.
    const applyGrid = (cols: number, rows: number) => {
      if (!(cols > 0) || !(rows > 0)) return;
      const c = Math.min(cols, MAX_COLS);
      const r = Math.min(rows, MAX_ROWS);
      if (term.cols !== c || term.rows !== r) term.resize(c, r);
    };
    // Opens or closes the stream so it matches whether anybody is looking. The open claims no size.
    const sync = () => {
      if (disposed) return;
      if (wantOpenRef.current && !openedRef.current) {
        if (!measured()) return;
        openedRef.current = true;
        void sendToHost(hostId, { t: "open", ptyId });
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

    const ro = new ResizeObserver(() => sync());
    ro.observe(container);

    // A snapshot replaces the screen: reset only once writes queued before it are applied, and hold the output that arrives meanwhile so it lands after.
    let held: string[] | null = null;
    let snapGen = 0;
    // A `resized` that arrives while a snapshot is being applied lands after it.
    let pendingGrid: { cols: number; rows: number } | null = null;
    const off = onHostMessages(hostId, (msgs) => {
      for (const m of msgs) {
        if (m.t === "snapshot" && m.ptyId === ptyId) {
          const gen = ++snapGen;
          const held0: string[] = (held = []);
          term.write("", () => {
            if (disposed || gen !== snapGen) return;
            applyGrid(m.cols, m.rows);
            term.reset();
            write(m.data);
            held = null;
            held0.forEach(write);
            if (pendingGrid) applyGrid(pendingGrid.cols, pendingGrid.rows);
            pendingGrid = null;
            setEnded(false);
          });
        } else if (m.t === "resized" && m.ptyId === ptyId) {
          // Writes queued before it are applied first, so the grid changes at the same point in the stream as on the host.
          if (held) pendingGrid = { cols: m.cols, rows: m.rows };
          else term.write("", () => !disposed && applyGrid(m.cols, m.rows));
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
      syncRef.current = () => {};
      if (openedRef.current) void sendToHost(hostId, { t: "close", ptyId });
      openedRef.current = false;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, ptyId]);

  // In or out of sight, or the link coming back (the server forgot its streams then): open or close; focus only when it comes into view, not when the link toggles.
  useEffect(() => {
    if (!online || linkRef.current !== link) openedRef.current = false;
    linkRef.current = link;
    const takeFocus = visible && !wasVisible.current;
    wasVisible.current = visible;
    const id = requestAnimationFrame(() => {
      syncRef.current();
      if (takeFocus) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [wantOpen, visible, online, link]);

  // A new font size only redraws: the grid stays the host's (the box follows on render).
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.fontSize = fontSize;
  }, [fontSize]);

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
      style={{ display: visible ? "flex" : "none", overflow: "auto", alignItems: "flex-start", ...(terminalPalette ? (resolveTerminalPalette(terminalPalette, theme, contrast) as CSSProperties) : null) }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        // On a link (xterm shows the pointer cursor only while one is hovered): that link's menu.
        const hovered = term?.element?.querySelector(".xterm-cursor-pointer") ? hoverLinkRef.current : null;
        if (hovered && "target" in hovered) return pathMenu(e, hovered.target, hovered.line);
        if (hovered && /^https?:\/\//i.test(hovered.uri)) return linkMenu(e, hovered.uri);
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
