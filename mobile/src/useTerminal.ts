import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { onMessage, send, type ConnStatus } from "./remote";
import { attachImeInput } from "./termIme";
import { isWebUrl } from "./termLinks";

const DEFAULT_FONT_SIZE = 13;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const RESIZE_DEBOUNCE_MS = 150;
/** Typing that lands within this long of a key/input event is the user's, never an echo to drop. */
const USER_INPUT_WINDOW_MS = 60;

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** Terminal colors come from the CSS variables the app theme sets on <html>. */
function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  const light = window.matchMedia("(prefers-color-scheme: light)").matches;
  const theme: ITheme = {
    background: v("--term-bg") ?? (light ? "#fbf9f4" : "#0f0e0c"),
    foreground: v("--term-fg") ?? (light ? "#26231d" : "#ece6da"),
    cursor: v("--term-cursor") ?? (light ? "#26231d" : "#c7d48f"),
    selectionBackground: v("--term-selection") ?? (light ? "#d9d3c4" : "#3b4630"),
  };
  const rec = theme as Record<string, string | undefined>;
  ANSI.forEach((n) => {
    rec[n] = v(`--ansi-${n}`);
    rec[`bright${n[0].toUpperCase()}${n.slice(1)}`] = v(`--ansi-bright-${n}`);
  });
  return theme;
}

/** Focus without letting the webview scroll the page to the textarea. */
export function focusTerminal(term: Terminal | null) {
  const ta = term?.textarea;
  if (ta) ta.focus({ preventScroll: true });
  else term?.focus();
}

/**
 * xterm's lifecycle for one pty: create, size it to the area, stream the
 * remote output in, send typed data out, tear down. `onInput` receives what the
 * user typed (the caller applies armed modifiers).
 */
export function useTerminal(opts: {
  ptyId: string;
  status: ConnStatus;
  fontSize: number | undefined;
  /** Changes when the app theme may have changed. */
  themeKey: unknown;
  onInput: (data: string) => void;
  /** An OSC 8 hyperlink was activated (web links only). */
  onLink?: (url: string) => void;
}) {
  const { ptyId, status, themeKey } = opts;
  const fontSize = opts.fontSize ?? DEFAULT_FONT_SIZE;
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** The phone's grid, once measured. */
  const gridRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  /** Whether the server has been told to stream this pty on the current connection. */
  const openedRef = useRef(false);
  /** Forgets the measured cell and measures again (font loaded or resized). */
  const remeasureRef = useRef<() => void>(() => {});
  const openIfReadyRef = useRef<() => void>(() => {});
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const onInputRef = useRef(opts.onInput);
  onInputRef.current = opts.onInput;
  const onLinkRef = useRef(opts.onLink);
  onLinkRef.current = opts.onLink;
  /** Ends the soft keyboard's line: text that bypasses it (key bar, inserted paths) must not be diffed against. */
  const imeResetRef = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    const area = areaRef.current!;
    let disposed = false;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: fontSizeRef.current,
      fontFamily: FONT_FAMILY,
      scrollback: 5000,
      cursorBlink: true,
      theme: readTheme(),
      linkHandler: {
        activate: (_e, uri) => {
          if (isWebUrl(uri)) onLinkRef.current?.(uri);
        },
        allowNonHttpProtocols: false,
      },
    });
    termRef.current = term;
    term.open(host);
    // Keystrokes land in xterm's own textarea: keep the phone keyboard from
    // "fixing" what is meant for a shell.
    const ta = term.textarea;
    ta?.setAttribute("autocapitalize", "off");
    ta?.setAttribute("autocorrect", "off");
    ta?.setAttribute("autocomplete", "off");
    ta?.setAttribute("spellcheck", "false");
    ta?.setAttribute("enterkeyhint", "send");
    const ime = ta ? attachImeInput(host, ta, (d) => onInputRef.current(d)) : null;
    imeResetRef.current = () => ime?.reset();

    // While remote output is being parsed xterm may answer terminal queries
    // (device attributes, cursor position...). The desktop's own terminal
    // already answered them, so a second reply would reach the shell as junk:
    // drop onData emitted during a write, unless the user is typing right now.
    let writing = 0;
    let userUntil = 0;
    const markUser = () => {
      userUntil = performance.now() + USER_INPUT_WINDOW_MS;
    };
    const userEvents = ["keydown", "keypress", "input", "paste", "compositionend"] as const;
    userEvents.forEach((n) => ta?.addEventListener(n, markUser, true));
    const write = (data: string) => {
      writing++;
      term.write(data, () => {
        writing--;
        updateBottom();
      });
    };
    const data = term.onData((d) => {
      if (writing > 0 && performance.now() > userUntil) return;
      onInputRef.current(d);
    });

    const updateBottom = () => {
      const b = term.buffer.active;
      setAtBottom(b.type === "alternate" || b.viewportY >= b.baseY);
    };
    const scroll = term.onScroll(updateBottom);
    const selection = term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    // Cell size comes from the rendered 80x24 screen rather than from font
    // metrics: that is exactly what xterm will lay out, whatever font the
    // system ended up with.
    let cell: { w: number; h: number } | null = null;
    let resizeTimer = 0;
    const openIfReady = () => {
      const grid = gridRef.current;
      if (!grid || statusRef.current !== "online" || openedRef.current || document.hidden) return;
      openedRef.current = true;
      send({ t: "open", ptyId, cols: grid.cols, rows: grid.rows });
    };
    openIfReadyRef.current = openIfReady;
    const measure = () => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!cell && screen && screen.offsetWidth > 0 && screen.offsetHeight > 0) {
        cell = { w: screen.offsetWidth / 80, h: screen.offsetHeight / 24 };
      }
      if (!cell || area.clientWidth === 0 || area.clientHeight === 0) return;
      const cols = Math.max(20, Math.floor(area.clientWidth / cell.w));
      const rows = Math.max(5, Math.floor(area.clientHeight / cell.h));
      const prev = gridRef.current;
      if (prev && prev.cols === cols && prev.rows === rows) return;
      gridRef.current = { cols, rows };
      setDims({ cols, rows });
      term.resize(cols, rows);
      if (openedRef.current) {
        // The keyboard animation fires many sizes: tell the pty only where it settles.
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          const g = gridRef.current;
          if (g && openedRef.current) send({ t: "resize", ptyId, cols: g.cols, rows: g.rows });
        }, RESIZE_DEBOUNCE_MS);
      } else openIfReady();
    };

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(area);
    // Font loading or a font-size change alters the cell size; measure again once it settles.
    const remeasure = () => {
      if (disposed) return;
      cell = null;
      gridRef.current = null;
      term.resize(80, 24);
      schedule();
    };
    remeasureRef.current = remeasure;
    void document.fonts?.ready.then(remeasure);
    schedule();

    // Out of sight nobody reads the stream: stop it (saves data and battery,
    // and the PC stops sending), and open it again on return.
    const onVisibility = () => {
      if (document.hidden) {
        if (openedRef.current) send({ t: "close", ptyId });
        openedRef.current = false;
      } else openIfReady();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // A snapshot replaces the screen: reset only once writes queued before it have been applied,
    // and hold the output that arrives meanwhile so it still lands after the snapshot.
    let held: string[] | null = null;
    let snapGen = 0;
    const off = onMessage((m) => {
      if (m.t === "snapshot" && m.ptyId === ptyId) {
        const gen = ++snapGen;
        const held0: string[] = (held = []);
        term.write("", () => {
          if (disposed || gen !== snapGen) return;
          term.reset();
          term.resize(m.cols, m.rows);
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
    });

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      off();
      data.dispose();
      scroll.dispose();
      selection.dispose();
      userEvents.forEach((n) => ta?.removeEventListener(n, markUser, true));
      ime?.detach();
      imeResetRef.current = () => {};
      window.clearTimeout(resizeTimer);
      cancelAnimationFrame(frame);
      ro.disconnect();
      remeasureRef.current = () => {};
      openIfReadyRef.current = () => {};
      if (openedRef.current) send({ t: "close", ptyId });
      openedRef.current = false;
      term.dispose();
      termRef.current = null;
      gridRef.current = null;
    };
  }, [ptyId]);

  // The desktop's font size is mirrored; a new size changes the cell, so measure again.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    remeasureRef.current();
  }, [fontSize]);

  // Re-read the colors after the app theme has been applied to <html>.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (termRef.current) termRef.current.options.theme = readTheme();
    });
    return () => cancelAnimationFrame(frame);
  }, [themeKey]);

  // After a reconnect the server forgot the stream: open again with the grid we have.
  useEffect(() => {
    if (status === "online") openIfReadyRef.current();
    else openedRef.current = false;
  }, [status]);

  const resetIme = useCallback(() => imeResetRef.current(), []);

  return { areaRef, hostRef, termRef, ended, dims, atBottom, hasSelection, resetIme };
}
