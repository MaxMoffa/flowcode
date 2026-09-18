import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginDef } from "./types";
import { usageFetcherFor, type UsageInfo } from "./usage";
import "./plugin-usage.css";

const RING_R = 13;
const RING_C = 2 * Math.PI * RING_R;
const STALE_MS = 30_000;
const POPOVER_WIDTH = 260;

interface PluginUsageButtonProps {
  plugin: PluginDef;
  icon: ReactNode;
  onRun: () => void;
}

/** A quick-action icon button - for a plugin with a known usage fetcher
 * (currently Codex CLI / Claude Code, see usage.ts), also a hover popover
 * with account status, and a ring around the icon for any metric that comes
 * back with a numeric fill level. Click always just runs the plugin; the
 * popover is purely informational and never intercepts the click. */
export function PluginUsageButton({ plugin, icon, onRun }: PluginUsageButtonProps) {
  const fetcher = usageFetcherFor(plugin.id);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchRef = useRef(0);

  function load() {
    if (!fetcher) return;
    if (usage && Date.now() - lastFetchRef.current < STALE_MS) return;
    lastFetchRef.current = Date.now();
    setLoading(true);
    fetcher()
      .then(setUsage)
      .finally(() => setLoading(false));
  }

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

  const ringMetric = usage?.metrics.find((m) => m.percent !== undefined);

  return (
    <div className="plugin-usage-anchor" onMouseEnter={show} onMouseLeave={scheduleHide}>
      <button
        ref={btnRef}
        type="button"
        className="icon-button plugin-usage-btn"
        aria-label={plugin.label}
        title={plugin.label}
        onClick={onRun}
      >
        {ringMetric && ringMetric.percent !== undefined && (
          <svg className="plugin-usage-ring" viewBox="0 0 28 28">
            <circle className="plugin-usage-ring-track" cx="14" cy="14" r={RING_R} />
            <circle
              className="plugin-usage-ring-fill"
              cx="14"
              cy="14"
              r={RING_R}
              style={{ strokeDasharray: `${ringMetric.percent * RING_C} ${RING_C}` }}
            />
          </svg>
        )}
        {icon}
      </button>
      {rect &&
        createPortal(
          <div
            className="plugin-usage-popover"
            style={{ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)) }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <div className="plugin-usage-popover-title">{plugin.label}</div>
            {loading && !usage && <div className="plugin-usage-popover-loading">Verifica in corso…</div>}
            {usage?.metrics.map((m, i) => (
              <div key={i} className="plugin-usage-metric">
                <div className="plugin-usage-metric-label">{m.label}</div>
                {m.percent !== undefined && (
                  <div className="plugin-usage-bar">
                    <div className="plugin-usage-bar-fill" style={{ width: `${Math.round(m.percent * 100)}%` }} />
                  </div>
                )}
                {m.detail && <div className="plugin-usage-metric-detail">{m.detail}</div>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
