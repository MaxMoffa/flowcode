import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatTokens, metricText, modelDisplayName, type UsageInfo } from "./usage";
import { useI18n } from "../i18n";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useActiveAgent } from "../agents/activeAgent";
import { cliOfPlugin } from "../agents/cliInfo";
import { readBool, usePersistentState, writeBool } from "../lib/storage";
import { writePty } from "../terminal/ptyClient";

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

/** Mirrors the Rust `AgentContext` (src-tauri/src/context.rs). */
interface AgentContext {
  used: number;
  window: number;
  windowEstimated: boolean;
  model: string | null;
}

const CONTEXT_POLL_MS = 5000;
const CONTEXT_OPEN_KEY = "flowcode.usage.contextOpen";
/** Pause between typing a slash command and its Enter: sent together, the TUI can take the burst for a paste and the Enter for a newline. */
const SUBMIT_DELAY_MS = 250;
/** How long the button stays in its "started" state after a compact was sent. */
const COMPACT_FEEDBACK_MS = 2500;

/** Asks the agent in the active tab to compact its context (`/compact`), as
 * if typed there. Off while the agent works: the command would queue behind
 * the running turn. */
function CompactButton({ ptyId, busy }: { ptyId: string; busy: boolean }) {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function compact() {
    setSent(true);
    await writePty(ptyId, "/compact");
    await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
    await writePty(ptyId, "\r");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSent(false), COMPACT_FEEDBACK_MS);
  }

  return (
    <button
      type="button"
      className="plugin-usage-compact-btn"
      disabled={busy || sent || !ptyId}
      title={busy ? t("usage.context.compactBusy") : undefined}
      onClick={() => void compact()}
    >
      {sent ? t("usage.context.compactSent") : t("usage.context.compact")}
    </button>
  );
}

/** How full the context window of the agent in the active terminal tab is.
 * Re-read every few seconds while expanded - the backend only reads the tail
 * of the session's transcript, so that stays cheap. */
function ContextSection({ pluginId }: { pluginId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = usePersistentState(CONTEXT_OPEN_KEY, (k) => readBool(k, false), writeBool);
  const agent = useActiveAgent();
  // Context is only read for Claude Code and Codex sessions.
  const pluginCli = cliOfPlugin(pluginId);
  const cli = pluginCli === "vibe" || pluginCli === "gemini" ? undefined : pluginCli;
  const mine = !!agent && agent.cli === cli;
  const sessionId = mine ? agent.sessionId : null;
  const profile = mine ? agent.profile : null;
  const readable = mine && !agent.wsl && !!sessionId;
  // `undefined`: not read yet, `null`: couldn't be.
  const [context, setContext] = useState<AgentContext | null | undefined>(undefined);
  // Why the last read failed, shown under "unavailable" to help diagnose it.
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    setContext(undefined);
    setReason(null);
    if (!open || !readable) return;
    let alive = true;
    const load = () =>
      invoke<AgentContext | null>("agent_context", { cli, sessionId, profile })
        .then((c) => {
          if (!alive) return;
          setReason(null);
          setContext(c);
        })
        .catch((e) => {
          if (!alive) return;
          setContext(null);
          setReason(String(e));
        });
    void load();
    const interval = setInterval(load, CONTEXT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [open, readable, cli, sessionId, profile]);

  // Only when the active tab runs this agent: otherwise there's nothing to show.
  if (!cli || !mine) return null;
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
        (!readable || context === null ? (
          <>
            <div className="plugin-usage-context-note">{t("usage.context.unavailable")}</div>
            {(() => {
              const text = !readable
                ? agent?.wsl
                  ? "WSL"
                  : !agent?.sessionId
                    ? "no session id"
                    : reason
                : reason;
              return text ? <div className="plugin-usage-context-note plugin-usage-context-reason">{text}</div> : null;
            })()}
          </>
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
      {open && mine && <CompactButton ptyId={agent.ptyId} busy={agent.status === "busy"} />}
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
  onMenuPointerEnter,
  onMenuPointerLeave,
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
  /** The profile list is portaled out of the popover: the hover-driven popover
   * passes its show/schedule-hide so the pointer on the list keeps it open. */
  onMenuPointerEnter?: () => void;
  onMenuPointerLeave?: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="plugin-usage-popover-head">
        <div className="plugin-usage-popover-title">{label}</div>
        {onProfileChange && <ProfileSelect
            value={profile}
            onChange={onProfileChange}
            onMenuPointerEnter={onMenuPointerEnter}
            onMenuPointerLeave={onMenuPointerLeave}
            filter={cliOfPlugin(pluginId) ? (p) => p.logged_in[cliOfPlugin(pluginId)!] : undefined}
          />}
      </div>
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
      <ContextSection pluginId={pluginId} />
    </>
  );
}
