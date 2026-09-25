import { useEffect, useRef, useState } from "react";
import { metricText, type UsageInfo } from "./usage";
import { useI18n } from "../i18n";

/** Small "copy debug info" button under a failed probe's "Unavailable":
 * the raw error/CLI output is useful for a bug report but just noise in the
 * popover itself. */
function CopyDebugButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button type="button" className="plugin-usage-debug-btn" onClick={copy}>
      {copied ? t("common.copied") : t("usage.copyDebug")}
    </button>
  );
}

/** The popover's inner content (title + metric rows) - just the markup,
 * no positioning or portal, so the shortcut-bar button and the plugin menu
 * can each wrap it in their own trigger/portal while rendering identically. */
export function UsagePopoverContent({
  label,
  usage,
  loading,
}: {
  label: string;
  usage: UsageInfo | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="plugin-usage-popover-title">{label}</div>
      {loading && !usage && <div className="plugin-usage-popover-loading">{t("common.checking")}</div>}
      {usage?.metrics.map((m, i) => {
        const warn = m.percent !== undefined && m.percent >= 0.75;
        const { label, detail } = metricText(m);
        return (
          <div key={i} className={`plugin-usage-metric${warn ? " plugin-usage-metric--warn" : ""}`}>
            <div className="plugin-usage-metric-top">
              <span className="plugin-usage-metric-label">{label}</span>
              {m.percent !== undefined && (
                <span className="plugin-usage-metric-pct">{Math.round(m.percent * 100)}%</span>
              )}
            </div>
            {m.percent !== undefined && (
              <div className="plugin-usage-bar">
                <div className="plugin-usage-bar-fill" style={{ width: `${Math.round(m.percent * 100)}%` }} />
              </div>
            )}
            {detail && <div className="plugin-usage-metric-detail">{detail}</div>}
          </div>
        );
      })}
      {usage?.debug && <CopyDebugButton text={usage.debug} />}
    </>
  );
}
