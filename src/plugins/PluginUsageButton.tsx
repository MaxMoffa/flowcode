import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginDef } from "./types";
import { useUsageState } from "./useUsageState";
import { usagePopoverPosition } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import "./plugin-usage.css";

interface PluginUsageButtonProps {
  plugin: PluginDef;
  icon: ReactNode;
  onRun: () => void;
}

/** A quick-action icon button - for a plugin with a known usage fetcher
 * (currently Codex CLI / Claude Code, see usage.ts), also a hover popover
 * with account status, and a mini bar under the icon for any metric that
 * comes back with a numeric fill level. Click always just runs the plugin;
 * the popover is purely informational and never intercepts the click. The
 * same popover also shows up on these plugins' rows in the "tutti i
 * plugin" menu - see PluginMenu.tsx, which shares useUsageState/
 * UsagePopoverContent/usagePopoverPosition with this component so both
 * stay in sync instead of drifting into two different caches/looks. */
export function PluginUsageButton({ plugin, icon, onRun }: PluginUsageButtonProps) {
  const { fetcher, usage, loading, load } = useUsageState(plugin.id);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    load();
  }

  function scheduleHide() {
    hideTimer.current = setTimeout(() => setRect(null), 160);
  }

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  if (!fetcher) {
    return (
      <button type="button" className="icon-button" aria-label={plugin.label} title={plugin.label} onClick={onRun}>
        {icon}
      </button>
    );
  }

  const barMetric = usage?.metrics.find((m) => m.percent !== undefined);
  const barWarn = barMetric?.percent !== undefined && barMetric.percent >= 0.75;

  return (
    <div className="plugin-usage-anchor" data-plugin={plugin.id} onMouseEnter={show} onMouseLeave={scheduleHide}>
      <button
        ref={btnRef}
        type="button"
        className="icon-button plugin-usage-btn"
        aria-label={plugin.label}
        title={plugin.label}
        onClick={onRun}
      >
        {icon}
        {barMetric && barMetric.percent !== undefined && (
          <span className={`plugin-usage-mini${barWarn ? " plugin-usage-mini--warn" : ""}`}>
            <span className="plugin-usage-mini-fill" style={{ "--fill": barMetric.percent } as CSSProperties} />
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
