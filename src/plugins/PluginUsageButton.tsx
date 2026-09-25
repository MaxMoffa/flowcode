import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginDef } from "./types";
import { useHoverPopover, useUsageState } from "./useUsageState";
import { usagePopoverPosition } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import { metricText } from "./usage";
import { useI18n } from "../i18n";
import "./plugin-usage.css";

interface PluginUsageButtonProps {
  plugin: PluginDef;
  icon: ReactNode;
  onRun: () => void;
}

/** A quick-action icon button - for a plugin with a known usage fetcher
 * (currently Codex CLI / Claude Code, see usage.ts), also a hover popover
 * with account status, and a mini bar under the icon showing whichever
 * reported limit is closest to running out. Click always just runs the plugin;
 * the popover is purely informational and never intercepts the click. The
 * same popover also shows up on these plugins' rows in the "tutti i
 * plugin" menu - see PluginMenu.tsx, which shares useUsageState/
 * UsagePopoverContent/usagePopoverPosition with this component so both
 * stay in sync instead of drifting into two different caches/looks. */
export function PluginUsageButton({ plugin, icon, onRun }: PluginUsageButtonProps) {
  useI18n();
  const { fetcher, usage, loading, load } = useUsageState(plugin.id);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { rect, show, scheduleHide } = useHoverPopover(btnRef, load);

  if (!fetcher) {
    return (
      <button type="button" className="icon-button" aria-label={plugin.label} title={plugin.label} onClick={onRun}>
        {icon}
      </button>
    );
  }

  // Always the rolling 5-hour session window, not the weekly one - that's
  // the limit that actually moves while you work, so it's the one worth a
  // glance at without opening the popover. The popover still lists every
  // metric (including the weekly one), labelled, in its own order.
  const barMetric =
    usage?.metrics.find((m) => m.kind === "session" && m.percent !== undefined && Number.isFinite(m.percent)) ??
    usage?.metrics.find((m) => m.percent !== undefined && Number.isFinite(m.percent));
  // Clamp: a future CLI wording change could yield something outside 0-1, and
  // a width over 100% would silently overflow the track instead of showing
  // "full".
  const barPct = barMetric?.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(barMetric.percent * 100)));
  const barWarn = barPct !== undefined && barPct >= 75;

  return (
    <div className="plugin-usage-anchor" data-plugin={plugin.id} onMouseEnter={show} onMouseLeave={scheduleHide}>
      <button
        ref={btnRef}
        type="button"
        className="icon-button plugin-usage-btn"
        aria-label={barPct === undefined ? plugin.label : `${plugin.label} - ${barMetric ? metricText(barMetric).label : ""}: ${barPct}%`}
        title={plugin.label}
        onClick={onRun}
      >
        {icon}
        {barPct !== undefined && (
          <span
            className={`plugin-usage-mini${barWarn ? " plugin-usage-mini--warn" : ""}`}
            data-pct={barPct}
          >
            <span className="plugin-usage-mini-fill" style={{ width: `${barPct}%` }} />
          </span>
        )}
      </button>
      {rect &&
        createPortal(
          <div
            className="plugin-usage-popover"
            data-plugin={plugin.id}
            style={usagePopoverPosition(rect)}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <UsagePopoverContent label={plugin.label} usage={usage} loading={loading} />
          </div>,
          document.body,
        )}
    </div>
  );
}
