import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RemoteClient, RemoteTab, Status } from "./client";
import { t } from "./i18n";
import { AgentBadge, StatusPill } from "./TabsScreen";

const FONT_SIZE = 12;
/** Below this the text is unreadable; the area pans horizontally instead. */
const MIN_SCALE = 0.5;

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

export function TerminalScreen({
  client,
  tab,
  status,
  onBack,
}: {
  client: RemoteClient;
  tab: RemoteTab;
  status: Status;
  onBack: () => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const gridRef = useRef({ cols: tab.cols, rows: tab.rows });
  gridRef.current = { cols: tab.cols, rows: tab.rows };
  const [ended, setEnded] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [text, setText] = useState("");
  const { ptyId } = tab;

  useEffect(() => {
    const host = hostRef.current!;
    const area = areaRef.current!;
    const sizer = sizerRef.current!;
    // The phone never resizes the pty: render at the desktop's grid.
    const term = new Terminal({
      cols: gridRef.current.cols,
      rows: gridRef.current.rows,
      fontSize: FONT_SIZE,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      theme: { background: "#0e0f12", foreground: "#e6e6e6" },
    });
    termRef.current = term;
    term.open(host);
    // xterm's hidden textarea would pop the keyboard up on every tap; input
    // goes through the bottom bar instead.
    const ta = host.querySelector("textarea");
    ta?.setAttribute("readonly", "");
    ta?.setAttribute("inputmode", "none");
    ta?.setAttribute("tabindex", "-1");

    // Fit the width: scale the fixed-size grid to the area, panning when
    // even MIN_SCALE doesn't fit.
    const fit = () => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || !screen.offsetWidth) return;
      const w = screen.offsetWidth;
      const h = screen.offsetHeight;
      const scale = Math.min(1.5, Math.max(MIN_SCALE, area.clientWidth / w));
      host.style.transform = `scale(${scale})`;
      sizer.style.width = `${Math.ceil(w * scale)}px`;
      sizer.style.height = `${Math.ceil(h * scale)}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    ro.observe(host);

    const off = client.onMessage((m) => {
      if (m.t === "snapshot" && m.ptyId === ptyId) {
        term.reset();
        term.resize(m.cols, m.rows);
        term.write(m.data);
      } else if (m.t === "output" && m.ptyId === ptyId) {
        term.write(m.data);
      } else if (m.t === "exit" && m.ptyId === ptyId) {
        setEnded(true);
      }
    });
    client.openPty(ptyId);
    return () => {
      off();
      client.closePty(ptyId);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [client, ptyId]);

  // Follows the desktop when it resizes; recreating the terminal for that
  // would drop the screen.
  useEffect(() => {
    const term = termRef.current;
    if (term && (term.cols !== tab.cols || term.rows !== tab.rows)) term.resize(tab.cols, tab.rows);
  }, [tab.cols, tab.rows]);

  function sendKey(seq: string) {
    if (ctrl && seq.length === 1 && /[a-zA-Z]/.test(seq)) seq = String.fromCharCode(seq.charCodeAt(0) & 0x1f);
    setCtrl(false);
    client.input(ptyId, seq);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text) return;
    // With Ctrl armed, a single typed letter is a chord (Ctrl+D, ...), not a line.
    if (ctrl && text.length === 1) sendKey(text);
    else client.input(ptyId, text + "\r");
    setCtrl(false);
    setText("");
  }

  return (
    <div className="rm-screen">
      <header className="rm-header">
        <button type="button" className="rm-back" aria-label={t("back")} onClick={onBack}>
          {"‹"}
        </button>
        <div className="rm-header-title">
          <span className="rm-tab-label">{tab.label}</span>
          <AgentBadge tab={tab} />
        </div>
        <StatusPill status={status} />
      </header>
      <div className="rm-term-area" ref={areaRef}>
        {ended && <div className="rm-ended">{t("ended")}</div>}
        <div ref={sizerRef} className="rm-term-sizer">
          <div ref={hostRef} className="rm-term-host" />
        </div>
      </div>
      <div className="rm-keys">
        <div className="rm-keyrow">
          <button type="button" className={"rm-key" + (ctrl ? " is-on" : "")} aria-pressed={ctrl} onClick={() => setCtrl((c) => !c)}>
            Ctrl
          </button>
          {KEYS.map((k) => (
            <button key={k.label} type="button" className="rm-key" onClick={() => sendKey(k.seq)}>
              {k.label}
            </button>
          ))}
        </div>
        <form className="rm-input" onSubmit={submit}>
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
          <button type="submit" className="rm-primary">
            {t("send")}
          </button>
        </form>
      </div>
    </div>
  );
}
