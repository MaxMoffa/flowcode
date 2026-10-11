import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { StatusPill } from "./common";
import { t } from "./i18n";
import { BackIcon, BoltIcon, FolderIcon } from "./icons";
import { onMessage, send, useRemote, type ConnStatus, type Tab } from "./remote";
import { TermActions } from "./TermActions";
import { TermFiles } from "./TermFiles";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, KeyboardIcon } from "./termIcons";

const DEFAULT_FONT_SIZE = 13;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

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

/** Home prefix to `~`, so the strip stays short. */
function homeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/(?:home|Users)\/[^/]+/, "~");
}

const SYMBOLS = ["|", "~", "/", "-", "_", ">", "&&", "$", "*", "`", "'", '"'];
const CTRL_CHIPS = [
  { label: "^C", seq: "\x03", danger: true },
  { label: "^D", seq: "\x04" },
  { label: "^L", seq: "\x0c" },
  { label: "^R", seq: "\x12" },
];

type Mods = { ctrl: boolean; alt: boolean; shift: boolean };
const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

/** Keeps the keyboard open (and xterm focused) while a bar button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

export function TerminalScreen({ tab, status, onBack }: { tab: Tab; status: ConnStatus; onBack: () => void }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** The phone's grid, once measured. */
  const gridRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef(status);
  /** Whether the server has been told to stream this pty on the current connection. */
  const openedRef = useRef(false);
  /** Forgets the measured cell and measures again (font loaded or resized). */
  const remeasureRef = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  const [mods, setModsState] = useState<Mods>(NO_MODS);
  const modsRef = useRef<Mods>(NO_MODS);
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { ptyId } = tab;
  const remote = useRemote();
  const { settings } = remote;
  const fontSize = settings?.terminalFontSize ?? DEFAULT_FONT_SIZE;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  statusRef.current = status;

  function setMods(m: Mods) {
    modsRef.current = m;
    setModsState(m);
  }

  function openIfReady() {
    const grid = gridRef.current;
    if (!grid || statusRef.current !== "online" || openedRef.current) return;
    openedRef.current = true;
    send({ t: "open", ptyId, cols: grid.cols, rows: grid.rows });
  }

  /** Everything typed or tapped goes through here so armed modifiers apply (one-shot). */
  function sendInput(data: string) {
    const m = modsRef.current;
    if (m.ctrl || m.alt || m.shift) {
      if (data.length === 1) {
        if (m.shift && /[a-z]/.test(data)) data = data.toUpperCase();
        if (m.ctrl && /[a-zA-Z@[\\\]^_]/.test(data)) data = String.fromCharCode(data.charCodeAt(0) & 0x1f);
      }
      if (m.alt) data = "\x1b" + data;
      setMods(NO_MODS);
    }
    send({ t: "input", ptyId, data });
  }
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  useEffect(() => {
    const host = hostRef.current!;
    const area = areaRef.current!;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: fontSizeRef.current,
      fontFamily: FONT_FAMILY,
      scrollback: 5000,
      cursorBlink: true,
      theme: readTheme(),
    });
    termRef.current = term;
    term.open(host);
    // Keystrokes land in xterm's own textarea: keep the phone keyboard from
    // "fixing" what is meant for a shell.
    const ta = host.querySelector("textarea");
    ta?.setAttribute("autocapitalize", "off");
    ta?.setAttribute("autocorrect", "off");
    ta?.setAttribute("autocomplete", "off");
    ta?.setAttribute("spellcheck", "false");
    ta?.setAttribute("enterkeyhint", "send");
    const onFocus = () => setKbOpen(true);
    const onBlur = () => setKbOpen(false);
    ta?.addEventListener("focus", onFocus);
    ta?.addEventListener("blur", onBlur);
    const data = term.onData((d) => sendInputRef.current(d));

    // Cell size comes from the rendered 80x24 screen rather than from font
    // metrics: that is exactly what xterm will lay out, whatever font the
    // system ended up with.
    let cell: { w: number; h: number } | null = null;
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
      if (openedRef.current) send({ t: "resize", ptyId, cols, rows });
      else openIfReady();
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
      cell = null;
      gridRef.current = null;
      term.resize(80, 24);
      schedule();
    };
    remeasureRef.current = remeasure;
    void document.fonts?.ready.then(remeasure);
    schedule();

    const off = onMessage((m) => {
      if (m.t === "snapshot" && m.ptyId === ptyId) {
        term.reset();
        term.resize(m.cols, m.rows);
        term.write(m.data);
        setEnded(false);
      } else if (m.t === "output" && m.ptyId === ptyId) {
        term.write(m.data);
      } else if (m.t === "exit" && m.ptyId === ptyId) {
        setEnded(true);
      }
    });

    return () => {
      off();
      data.dispose();
      ta?.removeEventListener("focus", onFocus);
      ta?.removeEventListener("blur", onBlur);
      cancelAnimationFrame(frame);
      ro.disconnect();
      remeasureRef.current = () => {};
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
  }, [settings]);

  // After a reconnect the server forgot the stream: open again with the grid we have.
  useEffect(() => {
    if (status === "online") openIfReady();
    else openedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeActions = useCallback(() => setActionsOpen(false), []);

  /** Types text as-is (no modifiers), then hands the keyboard back to the terminal. */
  function typeText(text: string, run?: boolean) {
    send({ t: "input", ptyId, data: run ? text + "\r" : text });
    setFilesOpen(false);
    termRef.current?.focus();
  }

  function toggleKeyboard() {
    if (kbOpen) termRef.current?.blur();
    else termRef.current?.focus();
  }

  const toggle = (k: keyof Mods) => setMods({ ...modsRef.current, [k]: !modsRef.current[k] });
  const sub = [tab.cli, homeCwd(tab.cwd)].filter(Boolean).join(" · ");
  const online = status === "online";

  return (
    <div className="screen term-screen">
      <header className="term-head">
        <button type="button" className="tm-btn plain" aria-label={t("back")} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="term-titles">
          <span className="term-title">{tab.label}</span>
          <span className="term-sub">{sub}</span>
        </div>
        {tab.cli ? <StatusPill status={tab.status} /> : null}
        <button type="button" className="tm-btn" aria-label={t("openFiles")} onClick={() => setFilesOpen(true)}>
          <FolderIcon />
        </button>
        <button type="button" className="tm-btn" aria-label={t("openFeatures")} onClick={() => setActionsOpen(true)}>
          <BoltIcon />
        </button>
      </header>
      <div className="term-card">
        <div className="term-strip">
          <span className="term-cwd">{homeCwd(tab.cwd)}</span>
          {dims && (
            <span className="term-dims">
              {dims.cols}×{dims.rows}
            </span>
          )}
          <span className={"term-live" + (online ? " on" : "")}>{online ? `● ${t("live")}` : t("offlineShort")}</span>
        </div>
        <div className="term-area" ref={areaRef} onClick={() => termRef.current?.focus()}>
          {ended && <div className="ended">{t("ended")}</div>}
          <div ref={hostRef} className="term-host" />
        </div>
      </div>
      <div className="tm-keys">
        <div className="tm-row">
          <div className="tm-seg" role="group">
            <button type="button" {...keepFocus} className={mods.ctrl ? "on" : ""} aria-pressed={mods.ctrl} onClick={() => toggle("ctrl")}>
              Ctrl
            </button>
            <button type="button" {...keepFocus} className={mods.alt ? "on" : ""} aria-pressed={mods.alt} onClick={() => toggle("alt")}>
              Alt
            </button>
            <button type="button" {...keepFocus} className={mods.shift ? "on" : ""} aria-pressed={mods.shift} onClick={() => toggle("shift")}>
              ⇧
            </button>
          </div>
          <button type="button" {...keepFocus} className="tm-key" onClick={() => sendInput("\x1b")}>
            Esc
          </button>
          <button type="button" {...keepFocus} className="tm-key" onClick={() => sendInput("\t")}>
            Tab
          </button>
          <div className="tm-arrows" role="group">
            <button type="button" {...keepFocus} aria-label={t("keyLeft")} onClick={() => sendInput("\x1b[D")}>
              <ArrowLeftIcon />
            </button>
            <button type="button" {...keepFocus} aria-label={t("keyUp")} onClick={() => sendInput("\x1b[A")}>
              <ArrowUpIcon />
            </button>
            <button type="button" {...keepFocus} aria-label={t("keyDown")} onClick={() => sendInput("\x1b[B")}>
              <ArrowDownIcon />
            </button>
            <button type="button" {...keepFocus} aria-label={t("keyRight")} onClick={() => sendInput("\x1b[C")}>
              <ArrowRightIcon />
            </button>
          </div>
        </div>
        <div className="tm-row2">
          <div className="tm-chips">
            {CTRL_CHIPS.map((c) => (
              <button key={c.label} type="button" {...keepFocus} className={"tm-chip" + (c.danger ? " danger" : "")} onClick={() => send({ t: "input", ptyId, data: c.seq })}>
                {c.label}
              </button>
            ))}
            <i className="tm-divider" />
            {SYMBOLS.map((s) => (
              <button key={s} type="button" {...keepFocus} className="tm-chip" onClick={() => sendInput(s)}>
                {s}
              </button>
            ))}
          </div>
          <button type="button" {...keepFocus} className="tm-chip tm-kbd" aria-label={kbOpen ? t("hideKeyboard") : t("showKeyboard")} onClick={toggleKeyboard}>
            <KeyboardIcon />
          </button>
        </div>
      </div>
      <TermFiles tab={tab} open={filesOpen} onClose={closeFiles} onType={typeText} />
      <TermActions tab={tab} actions={remote.actions} open={actionsOpen} onClose={closeActions} />
    </div>
  );
}
