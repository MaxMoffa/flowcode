import type { UsageInfo } from "./usage";

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
  return (
    <>
      <div className="plugin-usage-popover-title">{label}</div>
      {loading && !usage && <div className="plugin-usage-popover-loading">Verifica in corso…</div>}
      {usage?.metrics.map((m, i) => {
        const warn = m.percent !== undefined && m.percent >= 0.75;
        return (
          <div key={i} className={`plugin-usage-metric${warn ? " plugin-usage-metric--warn" : ""}`}>
            <div className="plugin-usage-metric-top">
              <span className="plugin-usage-metric-label">{m.label}</span>
              {m.percent !== undefined && (
                <span className="plugin-usage-metric-pct">{Math.round(m.percent * 100)}%</span>
              )}
            </div>
            {m.percent !== undefined && (
              <div className="plugin-usage-bar">
                <div className="plugin-usage-bar-fill" style={{ width: `${Math.round(m.percent * 100)}%` }} />
              </div>
            )}
            {m.detail && <div className="plugin-usage-metric-detail">{m.detail}</div>}
          </div>
        );
      })}
    </>
  );
}
