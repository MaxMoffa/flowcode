import { useEffect, useState } from "react";
import { t } from "./i18n";
import { connectionLog } from "./remote";

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

function formatEvent(e: { at: number; text: string }): string {
  const d = new Date(e.at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${e.text}`;
}

/** Collapsible list of the core's recent connection events, with a copy button to paste into a bug report. */
export function Diagnostics() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = () => void connectionLog().then((events) => setLines(events.map(formatEvent)));

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
        <span className="set-value">{open ? "−" : "+"}</span>
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
