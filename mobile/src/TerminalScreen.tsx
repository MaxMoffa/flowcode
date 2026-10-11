import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { StatusPill } from "./common";
import { t } from "./i18n";
import { BackIcon, SendIcon } from "./icons";
import { onMessage, send, type ConnStatus, type Tab } from "./remote";

const FONT_SIZE = 13;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "^C", seq: "\x03" },
  { label: "Enter", seq: "\r" },
];

function termTheme() {
  const light = window.matchMedia("(prefers-color-scheme: light)").matches;
  return light
    ? { background: "#fbf9f4", foreground: "#26231d", cursor: "#26231d", selectionBackground: "#d9d3c4" }
    : { background: "#0f0e0c", foreground: "#ece6da", cursor: "#c7d48f", selectionBackground: "#3b4630" };
}

export function TerminalScreen({ tab, status, onBack }: { tab: Tab; status: ConnStatus; onBack: () => void }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** The phone's grid, once measured. */
  const gridRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef(status);
  /** Whether the server has been told to stream this pty on the current connection. */
  const openedRef = useRef(false);
  const [ended, setEnded] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [text, setText] = useState("");
  const { ptyId } = tab;

  statusRef.current = status;

  function openIfReady() {
    const grid = gridRef.current;
    if (!grid || statusRef.current !== "online" || openedRef.current) return;
    openedRef.current = true;
    send({ t: "open", ptyId, cols: grid.cols, rows: grid.rows });
  }

  useEffect(() => {
    const host = hostRef.current!;
    const area = areaRef.current!;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY,
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      theme: termTheme(),
    });
    termRef.current = term;
    term.open(host);
    // xterm's hidden textarea would pop the keyboard up on every tap; input
    // goes through the bar below instead.
    const ta = host.querySelector("textarea");
    ta?.setAttribute("readonly", "");
    ta?.setAttribute("inputmode", "none");
    ta?.setAttribute("tabindex", "-1");

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
    // Font loading changes the cell size; measure again once it settles.
    void document.fonts?.ready.then(() => {
      cell = null;
      gridRef.current = null;
      term.resize(80, 24);
      schedule();
    });
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
      cancelAnimationFrame(frame);
      ro.disconnect();
      if (openedRef.current) send({ t: "close", ptyId });
      openedRef.current = false;
      term.dispose();
      termRef.current = null;
      gridRef.current = null;
    };
  }, [ptyId]);

  // After a reconnect the server forgot the stream: open again with the grid we have.
  useEffect(() => {
    if (status === "online") openIfReady();
    else openedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function sendKey(seq: string) {
    if (ctrl && seq.length === 1 && /[a-zA-Z]/.test(seq)) seq = String.fromCharCode(seq.charCodeAt(0) & 0x1f);
    setCtrl(false);
    send({ t: "input", ptyId, data: seq });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text) return;
    // With Ctrl armed, one typed letter is a chord (Ctrl+D...), not a line.
    if (ctrl && text.length === 1) sendKey(text);
    else send({ t: "input", ptyId, data: text + "\r" });
    setCtrl(false);
    setText("");
  }

  return (
    <div className="screen term-screen">
      <header className="term-head">
        <button type="button" className="icon-btn" aria-label={t("back")} onClick={onBack}>
          <BackIcon />
        </button>
        <span className="term-title">{tab.label}</span>
        {tab.cli ? <StatusPill status={tab.status} /> : null}
      </header>
      <div className="term-area" ref={areaRef}>
        {ended && <div className="ended">{t("ended")}</div>}
        <div ref={hostRef} className="term-host" />
      </div>
      <div className="keys">
        <div className="keyrow">
          <button type="button" className={"key" + (ctrl ? " on" : "")} aria-pressed={ctrl} onClick={() => setCtrl((c) => !c)}>
            Ctrl
          </button>
          {KEYS.map((k) => (
            <button key={k.label} type="button" className="key" onClick={() => sendKey(k.seq)}>
              {k.label}
            </button>
          ))}
        </div>
        <form className="composer" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("typeHere")}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button type="submit" className="send" aria-label={t("send")}>
            <SendIcon />
          </button>
        </form>
      </div>
    </div>
  );
}
