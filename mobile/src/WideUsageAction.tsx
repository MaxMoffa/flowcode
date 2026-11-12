import { useEffect, useMemo, useRef, useState } from "react";
import { useEscape } from "./back";
import { UsageCard, useNow } from "./HomeUsageCards";
import { t } from "./i18n";
import { ActionIcon } from "./icons";
import { useRemoteSelector, type Action, type UsageItem } from "./remote";

const LONG_PRESS_MS = 450;
const HOVER_CLOSE_MS = 180;

const pct = (m: { percent?: number }) => (typeof m.percent === "number" && Number.isFinite(m.percent) ? Math.max(0, Math.min(100, Math.round(m.percent * 100))) : undefined);

/** The "session" metric's percent, else the first metric with one (as the desktop's quick-action bar). */
function barOf(item: UsageItem): number | undefined {
  const m = item.metrics.find((x) => x.kind === "session" && pct(x) !== undefined) ?? item.metrics.find((x) => pct(x) !== undefined);
  return m ? pct(m) : undefined;
}

/**
 * A quick action of the header. With usage readings for its plugin (the
 * action id is the plugin id, as is `UsageItem.pluginId`) the icon gets a mini
 * bar and a profile colour dot like the desktop's, and a long press (touch)
 * or hover (mouse, pen) opens a popover with every reading. A tap just runs
 * the action; the long press that opened the popover does not.
 */
export function WideUsageAction({ action, onRun }: { action: Action; onRun: () => void }) {
  const usage = useRemoteSelector((r) => r.usage);
  const items = useMemo(() => (usage ?? []).filter((u) => u.pluginId === action.id), [usage, action.id]);
  const now = useNow();
  /** How the popover was opened: a hover closes when the pointer leaves, a long press on a tap outside. */
  const [via, setVia] = useState<"hover" | "press" | null>(null);
  const open = via !== null;
  const setOpen = (v: boolean) => setVia(v ? "press" : null);
  const timer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swallow = useRef(false);
  useEscape(open, () => setOpen(false));
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const run = (
    <button type="button" className="w-ib" aria-label={t("runAction", { label: action.label })} title={action.label} onClick={onRun}>
      <ActionIcon action={action} />
    </button>
  );
  if (items.length === 0) return run;

  // Several profiles may report for the plugin: the icon shows the one furthest along its session
  // window, i.e. the limit closest to running out (the desktop shows only its default profile).
  const lead = items.reduce((best, it) => ((barOf(it) ?? -1) > (barOf(best) ?? -1) ? it : best), items[0]);
  const barPct = barOf(lead);
  const cancelPress = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  const showHover = () => {
    window.clearTimeout(hideTimer.current);
    setVia((cur) => cur ?? "hover");
  };
  const hideHover = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVia((cur) => (cur === "hover" ? null : cur)), HOVER_CLOSE_MS);
  };
  const isMouse = (e: React.PointerEvent) => e.pointerType === "mouse" || e.pointerType === "pen";

  return (
    <div className="w-anchor w-usage" onPointerEnter={(e) => isMouse(e) && showHover()} onPointerLeave={(e) => isMouse(e) && hideHover()}>
      <button
        type="button"
        className="w-ib w-usage-btn"
        aria-label={t("runAction", { label: action.label }) + (barPct === undefined ? "" : ` - ${barPct}%`)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={action.label + " - " + t("usageHoldHint")}
        onClick={() => {
          if (swallow.current) {
            swallow.current = false;
            return;
          }
          setOpen(false);
          onRun();
        }}
        onPointerDown={(e) => {
          swallow.current = false;
          if (isMouse(e)) return;
          start.current = { x: e.clientX, y: e.clientY };
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            start.current = null;
            swallow.current = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => {
          // Android raises a context menu on a long press; the popover replaces it.
          e.preventDefault();
        }}
      >
        <ActionIcon action={action} />
        {lead.profile && lead.profileColor && <span className="w-usage-dot" style={{ background: lead.profileColor }} />}
        {barPct !== undefined && (
          <span className={"w-usage-mini" + (barPct >= 75 ? " warn" : "")} data-pct={barPct}>
            <span style={{ width: `${barPct}%` }} />
          </span>
        )}
      </button>
      {open && (
        <>
          {via === "press" && <div className="w-menu-scrim" onClick={() => setOpen(false)} />}
          <div className="w-usage-pop" role="dialog" aria-label={action.label} onPointerEnter={(e) => isMouse(e) && showHover()} onPointerLeave={(e) => isMouse(e) && hideHover()}>
            {items.map((it) => (
              <UsageCard key={it.pluginId + (it.profile ?? "")} item={it} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
