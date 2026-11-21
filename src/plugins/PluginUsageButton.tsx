import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PluginDef } from "./types";
import { useHoverPopover, useUsageProfile, useUsageState } from "./useUsageState";
import { usagePopoverPosition } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import { metricText, usageBarMetric } from "./usage";
import { useI18n } from "../i18n";
import { profileById, useProfiles } from "../profiles/profiles";
import "./plugin-usage.css";

interface PluginUsageButtonProps {
  plugin: PluginDef;
  icon: ReactNode;
  onRun: () => void;
  active?: boolean;
  /** Its panel is wanted open but has no room: a dot on the button (see usePanelLayout). */
  parked?: boolean;
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
export function PluginUsageButton({ plugin, icon, onRun, active, parked }: PluginUsageButtonProps) {
  const { t } = useI18n();
  const [profile, setProfile, profileReady] = useUsageProfile(plugin.id);
  const { fetcher, usage, loading, load } = useUsageState(plugin.id, profile, profileReady);
  const profileInfo = profileById(useProfiles(), profile);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { rect, show, scheduleHide, hide } = useHoverPopover(btnRef, load);

  if (!fetcher) {
    return (
      <button
        type="button"
        className={"icon-button" + (active ? " is-active" : "") + (parked ? " is-parked" : "")}
        aria-pressed={active}
        aria-label={plugin.label}
        title={plugin.label}
        data-plugin={plugin.id}
        onClick={onRun}
      >
        {icon}
      </button>
    );
  }

  const barMetric = usageBarMetric(usage?.metrics);
  // Clamp: a future CLI wording change could yield something outside 0-1, and
  // a width over 100% would silently overflow the track instead of showing
  // "full".
  const barPct = barMetric?.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(barMetric.percent * 100)));
  const offline = !!usage?.offline;
  const barWarn = !offline && barPct !== undefined && barPct >= 75;
  const offlineTitle = !offline
    ? plugin.label
    : barPct !== undefined && usage?.fetchedAt
      ? t("usage.offlineTooltip", { label: plugin.label, time: new Date(usage.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
      : `${plugin.label} · ${t("usage.offline")}`;

  return (
    <div className="plugin-usage-anchor" data-plugin={plugin.id} onMouseEnter={show} onMouseLeave={scheduleHide} onContextMenu={hide}>
      <button
        ref={btnRef}
        type="button"
        className={"icon-button plugin-usage-btn" + (offline ? " is-offline" : "")}
        aria-label={barPct === undefined ? plugin.label : `${plugin.label} - ${barMetric ? metricText(barMetric).label : ""}: ${barPct}%`}
        title={offlineTitle}
        onClick={onRun}
      >
        {icon}
        {profileInfo && <span className="plugin-usage-profile-badge" style={{ background: profileInfo.color }} />}
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
            <UsagePopoverContent
              pluginId={plugin.id}
              label={plugin.label}
              usage={usage}
              loading={loading}
              profile={profile}
              onProfileChange={setProfile}
              onMenuPointerEnter={show}
              onMenuPointerLeave={scheduleHide}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
