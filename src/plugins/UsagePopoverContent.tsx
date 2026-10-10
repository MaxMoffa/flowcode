import { useEffect, useRef, useState } from "react";
import { metricText, type UsageInfo } from "./usage";
import { useI18n } from "../i18n";
import { useProfiles } from "../profiles/profiles";

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

/** "Default | Work | Personal": which account's usage the popover shows. Only
 * rendered once at least one profile exists. */
function ProfileSwitcher({
  profile,
  onChange,
}: {
  profile: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const { t } = useI18n();
  const { profiles } = useProfiles();
  if (profiles.length === 0) return null;
  return (
    <div className="plugin-usage-profiles" role="group" aria-label={t("usage.profile.label")}>
      <button
        type="button"
        className={"plugin-usage-profile" + (profile === undefined ? " is-active" : "")}
        aria-pressed={profile === undefined}
        onClick={() => onChange(undefined)}
      >
        {t("agents.profile.default")}
      </button>
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          className={"plugin-usage-profile" + (profile === p.id ? " is-active" : "")}
          aria-pressed={profile === p.id}
          onClick={() => onChange(p.id)}
        >
          <span className="plugin-usage-profile-dot" style={{ background: p.color }} />
          {p.name}
        </button>
      ))}
    </div>
  );
}

/** The popover's inner content (title + metric rows) - just the markup,
 * no positioning or portal, so the shortcut-bar button and the plugin menu
 * can each wrap it in their own trigger/portal while rendering identically. */
export function UsagePopoverContent({
  label,
  usage,
  loading,
  profile,
  onProfileChange,
}: {
  label: string;
  usage: UsageInfo | null;
  loading: boolean;
  /** The account shown, and how to switch it - omitted for a plugin whose
   * usage doesn't depend on one, which gets no switcher. */
  profile?: string;
  onProfileChange?: (next: string | undefined) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="plugin-usage-popover-title">{label}</div>
      {onProfileChange && <ProfileSwitcher profile={profile} onChange={onProfileChange} />}
      {loading && !usage && <div className="plugin-usage-popover-loading">{t("common.checking")}</div>}
      {usage?.metrics.map((m, i) => {
        const warn = m.percent !== undefined && m.percent >= 0.75;
        const { label, detail, value } = metricText(m);
        return (
          <div key={i} className={`plugin-usage-metric${warn ? " plugin-usage-metric--warn" : ""}`}>
            <div className="plugin-usage-metric-top">
              <span className="plugin-usage-metric-label">{label}</span>
              {m.percent !== undefined ? (
                <span className="plugin-usage-metric-pct">{Math.round(m.percent * 100)}%</span>
              ) : (
                value && (
                  <span className={`plugin-usage-metric-pct${m.kind === "model" ? " plugin-usage-metric-pct--text" : ""}`}>
                    {value}
                  </span>
                )
              )}
            </div>
            {m.percent !== undefined && (
              <div className="plugin-usage-bar">
                <div className="plugin-usage-bar-fill" style={{ width: `${Math.round(m.percent * 100)}%` }} />
              </div>
            )}
            {detail && <div className="plugin-usage-metric-detail">{detail}</div>}
            {m.command && (m.kind === "loggedOut" || m.kind === "reauth" || m.kind === "noApiKey") && (
              <button
                type="button"
                className="plugin-usage-login-btn"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("flowcode:cli-login", { detail: { command: m.command, profile } }))
                }
              >
                {m.kind === "noApiKey" ? t("usage.setup") : t("usage.login")}
              </button>
            )}
          </div>
        );
      })}
      {usage?.debug && <CopyDebugButton text={usage.debug} />}
    </>
  );
}
