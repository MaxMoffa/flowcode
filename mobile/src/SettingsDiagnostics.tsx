import { useEffect, useState } from "react";
import { t } from "./i18n";
import { connectionLog } from "./remote";

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

function formatEvent(e: { at: number; text: string }): string {
  const d = new Date(e.at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${e.text}`;
}

/** The link-quality line the core keeps up to date ("link: direct 18 ms, tx ..."), as "Diretto · 18 ms" / "Via relay · 140 ms". */
function linkSummary(events: { text: string }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = /^link: (direct|relay) (\d+) ms/.exec(events[i].text);
    if (m) return `${m[1] === "direct" ? t("connPathDirect") : t("connPathRelay")} · ${m[2]} ms`;
  }
  return null;
}

/** Collapsible list of the core's recent connection events, with a copy button to paste into a bug report. */
export function Diagnostics() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () =>
    void connectionLog().then((events) => {
      setLines(events.map(formatEvent));
      setSummary(linkSummary(events));
    });

  // Once on mount, so the closed row can show the path too.
  useEffect(refresh, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (no permission): the list is still selectable.
    }
  };

  return (
    <>
      <button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-label">{t("connDiag")}</span>
        <span className="set-value">{summary ? `${summary} ${open ? "−" : "+"}` : open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="set-block">
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={() => void copy()}>
              {copied ? t("connDiagCopied") : t("connDiagCopy")}
            </button>
            <button type="button" className="btn ghost" onClick={refresh}>
              {t("connDiagRefresh")}
            </button>
          </div>
          <pre style={{ margin: 0, maxHeight: 260, overflow: "auto", fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text" }}>
            {lines.length ? lines.join("\n") : t("connDiagEmpty")}
          </pre>
        </div>
      )}
    </>
  );
}
