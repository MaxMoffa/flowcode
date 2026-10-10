import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatTokens, metricText, modelDisplayName, type UsageInfo } from "./usage";
import { useI18n } from "../i18n";
import { useProfiles } from "../profiles/profiles";
import { useActiveAgent } from "../agents/activeAgent";
import { readBool, usePersistentState, writeBool } from "../lib/storage";

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

/** Mirrors the Rust `AgentContext` (src-tauri/src/context.rs). */
interface AgentContext {
  used: number;
  window: number;
  windowEstimated: boolean;
  model: string | null;
}

/** The CLI whose sessions each usage plugin's account belongs to. */
const PLUGIN_CLI: Record<string, string> = { "claude-code": "claude", "codex-cli": "codex" };

const CONTEXT_POLL_MS = 5000;
const CONTEXT_OPEN_KEY = "flowcode.usage.contextOpen";

/** How full the context window of the agent in the active terminal tab is.
 * Re-read every few seconds while expanded - the backend only reads the tail
 * of the session's transcript, so that stays cheap. */
function ContextSection({ pluginId, label }: { pluginId: string; label: string }) {
  const { t } = useI18n();
  const [open, setOpen] = usePersistentState(CONTEXT_OPEN_KEY, (k) => readBool(k, false), writeBool);
  const agent = useActiveAgent();
  const cli = PLUGIN_CLI[pluginId];
  const mine = !!agent && agent.cli === cli;
  const sessionId = mine ? agent.sessionId : null;
  const profile = mine ? agent.profile : null;
  const readable = mine && !agent.wsl && !!sessionId;
  // `undefined`: not read yet, `null`: couldn't be.
  const [context, setContext] = useState<AgentContext | null | undefined>(undefined);

  useEffect(() => {
    setContext(undefined);
    if (!open || !readable) return;
    let alive = true;
    const load = () =>
      invoke<AgentContext | null>("agent_context", { cli, sessionId, profile })
        .then((c) => alive && setContext(c))
        .catch(() => alive && setContext(null));
    void load();
    const interval = setInterval(load, CONTEXT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [open, readable, cli, sessionId, profile]);

  if (!cli) return null;
  const percent = context ? Math.min(1, context.used / context.window) : 0;
  const warn = percent >= 0.75;
  return (
    <div className="plugin-usage-context">
      <button
        type="button"
        className={"plugin-usage-context-toggle" + (open ? " is-open" : "")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t("usage.context")}
        <svg
          className="plugin-usage-context-chevron"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open &&
        (!mine ? (
          <div className="plugin-usage-context-note">{t("usage.context.noSession", { agent: label })}</div>
        ) : !readable || context === null ? (
          <div className="plugin-usage-context-note">{t("usage.context.unavailable")}</div>
        ) : context ? (
          <div className={`plugin-usage-metric${warn ? " plugin-usage-metric--warn" : ""}`}>
            <div className="plugin-usage-metric-top">
              <span className="plugin-usage-metric-label">{t("usage.context.used")}</span>
              <span className="plugin-usage-metric-pct">{Math.round(percent * 100)}%</span>
            </div>
            <div className="plugin-usage-bar">
              <div className="plugin-usage-bar-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
            </div>
            <div className="plugin-usage-metric-detail">
              {[
                t("usage.context.detail", {
                  used: formatTokens(context.used),
                  window: (context.windowEstimated ? "~" : "") + formatTokens(context.window),
                }),
                context.model && modelDisplayName(context.model),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {agent.tabLabel && <div className="plugin-usage-metric-detail">{agent.tabLabel}</div>}
          </div>
        ) : null)}
    </div>
  );
}

/** The popover's inner content (title + metric rows) - just the markup,
 * no positioning or portal, so the shortcut-bar button and the plugin menu
 * can each wrap it in their own trigger/portal while rendering identically. */
export function UsagePopoverContent({
  pluginId,
  label,
  usage,
  loading,
  profile,
  onProfileChange,
}: {
  /** Which plugin's popover this is - the context section is for the CLIs only. */
  pluginId: string;
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
      <ContextSection pluginId={pluginId} label={label} />
    </>
  );
}
