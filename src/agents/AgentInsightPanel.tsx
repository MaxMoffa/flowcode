import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { SegmentedSwitch } from "../lib/SegmentedSwitch";
import { readEnum, usePersistentState, writeString } from "../lib/storage";
import { formatTokens, metricText, modelDisplayName } from "../plugins/usage";
import { useUsageState } from "../plugins/useUsageState";
import { writePty } from "../terminal/ptyClient";
import { useTabDelegation } from "../chat/delegateStore";
import type { DelegateInfo } from "../chat/chatModel";
import { useActiveAgent, type ActiveAgent } from "./activeAgent";
import { useAgentToolsSettings } from "./agentToolsSettings";
import { DelegatesPane } from "./DelegatesPane";
import { CLI_INFO, type AgentCli } from "./cliInfo";
import {
  cacheHitRatio,
  contextSegments,
  estTokensOfChars,
  planKind,
  sparkBars,
  type AgentTools,
  type SessionUsage,
} from "./insightMath";
import { useAgentTools, usePolled, useSessionUsage, type Loaded } from "./useAgentInsight";
import "./agents-sidebar.css";
import "./agent-insight.css";

/** Mirrors the Rust `AgentContext` (src-tauri/src/context.rs). */
interface AgentContext {
  used: number;
  window: number;
  windowEstimated: boolean;
  model: string | null;
}

const TABS = ["context", "usage", "delegates"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY = "flowcode.agentPanel.tab";
const CONTEXT_POLL_MS = 5000;
/** Pause between typing a slash command and its Enter, so the TUI doesn't take the burst for a paste. */
const SUBMIT_DELAY_MS = 250;
const COMPACT_FEEDBACK_MS = 2500;
const WARN_AT = 0.75;

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <polyline points="20 4 20 11 13 11" />
    </svg>
  );
}

function RobotIcon() {
  return (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
    </svg>
  );
}

interface AgentInsightPanelProps {
  onClose: () => void;
  onCompactChat?: () => void;
  /** Opens a delegate's chat in a tab next to its orchestrator's. */
  onOpenDelegate?: (parentTabId: string, delegate: DelegateInfo, wslDistro: string | null) => void;
  /** Brings a tab to the front. */
  onFocusTab?: (tabId: string) => void;
}

/** The right-hand panel for the agent in front (chat or terminal): context
 * fill with a "compact" action, then context (with the tools it is made of), usage and delegates tabs. */
export function AgentInsightPanel({ onClose, onCompactChat, onOpenDelegate, onFocusTab }: AgentInsightPanelProps) {
  const { t } = useI18n();
  const agent = useActiveAgent();
  return (
    <div className="agents-sidebar agent-insight">
      <div className="agents-sidebar-head">
        <div className="agents-sidebar-header">
          <button type="button" className="agents-sidebar-close" title={t("agentPanel.close")} aria-label={t("agentPanel.close")} onClick={onClose}>
            <CloseIcon />
          </button>
          <span className="agents-sidebar-title">{t("agentPanel.title")}</span>
        </div>
      </div>
      {agent ? (
        <AgentBody agent={agent} onCompactChat={onCompactChat} onOpenDelegate={onOpenDelegate} onFocusTab={onFocusTab} />
      ) : (
        <div className="agent-insight-empty">
          <RobotIcon />
          <b>{t("agentPanel.empty")}</b>
          <span>{t("agentPanel.emptyHint")}</span>
        </div>
      )}
    </div>
  );
}

function AgentBody({ agent, onCompactChat, onOpenDelegate, onFocusTab }: { agent: ActiveAgent; onCompactChat?: () => void } & Pick<AgentInsightPanelProps, "onOpenDelegate" | "onFocusTab">) {
  const { t } = useI18n();
  const agentTools = useAgentToolsSettings();
  const delegation = useTabDelegation(agent.kind === "chat" ? agent.tabId : null);
  // Only a chat can delegate; the tab shows while the feature is on, or when this chat has (or is) a delegate.
  const showDelegates = agent.kind === "chat" && ((agentTools.enabled && agentTools.delegate) || delegation.delegates.length > 0 || !!agent.delegateOf);
  const [storedTab, setTab] = usePersistentState<Tab>(TAB_KEY, (k) => readEnum(k, TABS, "context"), writeString);
  const tab: Tab = storedTab === "delegates" && !showDelegates ? "context" : storedTab;
  const cli = agent.cli;
  const readable = (cli === "claude" || cli === "codex") && !agent.wsl && !!agent.sessionId;
  const context = usePolled(
    () => invoke<AgentContext | null>("agent_context", { cli, sessionId: agent.sessionId, profile: agent.profile }),
    `${cli}|${agent.sessionId}|${agent.profile}`,
    CONTEXT_POLL_MS,
    readable,
  );
  const { tools, supported: toolsSupported, reload } = useAgentTools(cli, agent.cwd, agent.profile, tab === "context");

  const ctx = context ?? null;
  const percent = ctx && ctx.window > 0 ? Math.min(1, ctx.used / ctx.window) : null;
  const warn = percent !== null && percent >= WARN_AT;
  const label = CLI_INFO[cli as AgentCli]?.name ?? cli;
  const chip = [label, ctx?.model && modelDisplayName(ctx.model), agent.kind === "chat" ? t("agentPanel.chat") : t("agentPanel.terminal")]
    .filter(Boolean)
    .join(" · ");
  const busy = agent.status === "busy";

  return (
    <div className="agent-insight-body">
      <div className="agent-insight-top">
        <div className="agent-insight-chip" title={chip}>
          {chip}
        </div>
        <div className="agent-insight-hero">
          <span className={"agent-insight-big" + (warn ? " is-warn" : "")}>{percent === null ? "—" : `${Math.round(percent * 100)}%`}</span>
          <span className="agent-insight-muted agent-insight-hero-detail">
            {ctx
              ? t("agentPanel.ofWindow", {
                  used: formatTokens(ctx.used),
                  window: (ctx.windowEstimated ? "~" : "") + formatTokens(ctx.window),
                })
              : contextNote(agent, readable, context, t)}
          </span>
          <CompactButton agent={agent} busy={busy} onCompactChat={onCompactChat} />
        </div>
        <div className={"agent-insight-meter" + (warn ? " is-warn" : "")}>
          <i style={{ width: `${Math.round((percent ?? 0) * 100)}%` }} />
        </div>
        <SegmentedSwitch<Tab>
          ariaLabel={t("agentPanel.tabs")}
          idPrefix="agent-insight"
          value={tab}
          onChange={setTab}
          options={[
            { id: "context", label: t("agentPanel.tab.context") },
            { id: "usage", label: t("agentPanel.tab.usage") },
            ...(showDelegates ? [{ id: "delegates" as const, label: t("agentPanel.tab.delegates"), count: delegation.delegates.length }] : []),
          ]}
        />
      </div>
      <div className="agent-insight-pane" role="tabpanel" id={`agent-insight-panel-${tab}`} aria-labelledby={`agent-insight-tab-${tab}`}>
        {tab === "context" && <ContextPane agent={agent} ctx={ctx} tools={tools} toolsSupported={toolsSupported} onRefresh={reload} warn={warn} />}
        {tab === "usage" && <UsagePane agent={agent} />}
        {tab === "delegates" && <DelegatesPane agent={agent} onOpenDelegate={onOpenDelegate} onFocusTab={onFocusTab} />}
      </div>
    </div>
  );
}

function contextNote(
  agent: ActiveAgent,
  readable: boolean,
  context: Loaded<AgentContext | null>,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (agent.cli !== "claude" && agent.cli !== "codex") return t("agentPanel.ctx.unsupported");
  if (agent.wsl) return t("agentPanel.ctx.noWsl");
  if (!agent.sessionId) return t("agentPanel.ctx.noSession");
  if (readable && context === null) return t("usage.context.unavailable");
  return "";
}

/** Asks the agent to compact its context: typed into the terminal, or sent as
 * a prompt in a chat. Off while the agent works - the command would queue behind the turn. */
function CompactButton({ agent, busy, onCompactChat }: { agent: ActiveAgent; busy: boolean; onCompactChat?: () => void }) {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function compact() {
    setSent(true);
    if (agent.kind === "chat") {
      onCompactChat?.();
    } else {
      await writePty(agent.ptyId, "/compact");
      await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
      await writePty(agent.ptyId, "\r");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSent(false), COMPACT_FEEDBACK_MS);
  }

  const available = agent.kind === "chat" ? !!onCompactChat : !!agent.ptyId;
  return (
    <button
      type="button"
      className="agent-insight-btn"
      disabled={busy || sent || !available}
      title={busy ? t("usage.context.compactBusy") : sent ? t("usage.context.compactSent") : t("usage.context.compact")}
      onClick={() => void compact()}
    >
      {t("agentPanel.compact")}
    </button>
  );
}

function Row({ swatch, name, value, title, muted }: { swatch?: ReactNode; name: ReactNode; value?: ReactNode; title?: string; muted?: boolean }) {
  return (
    <div className="agent-insight-row" title={title}>
      {swatch}
      <span className={"agent-insight-row-name" + (muted ? " agent-insight-muted" : "")}>{name}</span>
      {value !== undefined && <span className="agent-insight-row-value">{value}</span>}
    </div>
  );
}

type GroupId = "memory" | "skill" | "mcp";

/** A legend row that opens onto the list behind its number (collapsed until asked). */
function Group({ open, onToggle, swatch, name, value, children }: { open: boolean; onToggle: () => void; swatch: ReactNode; name: ReactNode; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="agent-insight-grp">
      <button type="button" className={"agent-insight-row agent-insight-grp-head" + (open ? " is-open" : "")} aria-expanded={open} onClick={onToggle}>
        <ChevronIcon />
        {swatch}
        <span className="agent-insight-row-name">{name}</span>
        {value !== undefined && <span className="agent-insight-row-value">{value}</span>}
      </button>
      {open && <div className="agent-insight-grp-body">{children}</div>}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="agent-insight-grp-chev" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function ContextPane({
  agent,
  ctx,
  tools,
  toolsSupported,
  onRefresh,
  warn,
}: {
  agent: ActiveAgent;
  ctx: AgentContext | null;
  tools: Loaded<AgentTools>;
  toolsSupported: boolean;
  onRefresh: () => void;
  warn: boolean;
}) {
  const { t } = useI18n();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<GroupId>>(new Set());
  const toggle = (id: GroupId) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const skillTokens = tools?.skills.reduce((n, s) => n + s.estTokens, 0) ?? 0;
  const seg = ctx ? contextSegments(ctx.used, ctx.window, tools?.memoryChars ?? 0, skillTokens) : null;
  const memoryTokens = seg ? seg.memory : estTokensOfChars(tools?.memoryChars ?? 0);
  const skillsShown = seg ? seg.skills : skillTokens;
  /** The expanded group's content while the tools are not (yet) there. */
  const toolsNote = !toolsSupported ? (
    <div className="agent-insight-note">{t("agentPanel.tools.unsupported")}</div>
  ) : tools === undefined ? (
    <div className="agent-insight-note">{t("common.checking")}</div>
  ) : tools === null ? (
    <>
      <div className="agent-insight-note">{t("agentPanel.tools.unavailable")}</div>
      <RefreshButton onRefresh={onRefresh} />
    </>
  ) : null;
  const none = <div className="agent-insight-note">{t("agentPanel.tools.none")}</div>;
  const count = (n: number | undefined) => (n === undefined ? "" : `${n} · `);
  const pad = <span className="agent-insight-grp-pad" />;
  return (
    <>
      {ctx && seg ? (
        <div className="agent-insight-stack">
          {[
            { key: "mem", color: "var(--c-mem)", n: seg.memory },
            { key: "skill", color: "var(--c-skill)", n: seg.skills },
            { key: "conv", color: "var(--c-msg)", n: seg.conversation },
          ].map((i) => (
            <i key={i.key} style={{ width: `${(i.n / ctx.window) * 100}%`, background: i.color }} />
          ))}
        </div>
      ) : (
        <div className="agent-insight-note">{t("usage.context.unavailable")}</div>
      )}
      <Group
        open={openGroups.has("memory")}
        onToggle={() => toggle("memory")}
        swatch={<span className="agent-insight-sw" style={{ background: "var(--c-mem)" }} />}
        name={t("agentPanel.ctx.memory")}
        value={`${count(tools?.memoryFiles.length)}${formatTokens(memoryTokens)}`}
      >
        {toolsNote ??
          (tools && tools.memoryFiles.length > 0
            ? tools.memoryFiles.map((f) => <Row key={f} name={f.split(/[\/]/).pop()} title={f} />)
            : none)}
      </Group>
      <Group
        open={openGroups.has("skill")}
        onToggle={() => toggle("skill")}
        swatch={<span className="agent-insight-sw" style={{ background: "var(--c-skill)" }} />}
        name={t("agentPanel.ctx.skills")}
        value={`${count(tools?.skills.length)}${formatTokens(skillsShown)}`}
      >
        {toolsNote ??
          (tools && tools.skills.length > 0
            ? tools.skills.map((s) => (
                <Row
                  key={`${s.scope}:${s.name}`}
                  name={s.name}
                  value={
                    <>
                      <span className="agent-insight-badge">{s.scope}</span> {t("agentPanel.tools.estTokens", { n: formatTokens(s.estTokens) })}
                    </>
                  }
                />
              ))
            : none)}
      </Group>
      <Group
        open={openGroups.has("mcp")}
        onToggle={() => toggle("mcp")}
        swatch={<span className="agent-insight-sw agent-insight-sw--mcp" />}
        name={t("agentPanel.ctx.mcp")}
        value={tools ? tools.mcp.length : undefined}
      >
        {toolsNote ?? (
          <>
            <div className="agent-insight-grp-sub">
              <span>{t("agentPanel.ctx.configured")}</span>
              <RefreshButton onRefresh={onRefresh} />
            </div>
            {tools && tools.mcp.length > 0
              ? tools.mcp.map((m) => (
                  <Row
                    key={`${m.scope}:${m.name}`}
                    name={m.name}
                    title={m.target}
                    value={
                      <>
                        <span className="agent-insight-badge">{m.transport}</span> <span className="agent-insight-badge">{m.scope}</span>
                      </>
                    }
                  />
                ))
              : none}
          </>
        )}
      </Group>
      {seg && (
        <>
          <Row swatch={<>{pad}<span className="agent-insight-sw" style={{ background: "var(--c-msg)" }} /></>} name={t("agentPanel.ctx.conversation")} value={formatTokens(seg.conversation)} />
          <Row swatch={<>{pad}<span className="agent-insight-sw agent-insight-sw--free" /></>} name={t("agentPanel.ctx.free")} value={formatTokens(seg.free)} muted />
          {warn && <div className="agent-insight-tip">{t("agentPanel.ctx.full")}</div>}
        </>
      )}
      {openGroups.size > 0 && tools && <div className="agent-insight-note agent-insight-foot">{t("agentPanel.tools.note")}</div>}
      <div className="agent-insight-section">
        {ctx?.model && <Row name={t("agentPanel.ctx.model")} value={modelDisplayName(ctx.model)} />}
        {agent.tabLabel && <Row name={t("agentPanel.ctx.tab")} value={agent.tabLabel} />}
      </div>
    </>
  );
}

function UsagePane({ agent }: { agent: ActiveAgent }) {
  const { t } = useI18n();
  const cli = agent.cli as AgentCli;
  const pluginId = CLI_INFO[cli]?.pluginId ?? "";
  const profile = agent.profile ?? undefined;
  const { fetcher, usage, loading } = useUsageState(pluginId, profile);
  const kind = usage ? planKind(usage.metrics) : "other";
  const session = useSessionUsage(agent, !agent.wsl);
  return (
    <>
      {fetcher && (
        <div className="agent-insight-section">
          <div className="agent-insight-title">
            {kind === "payg" ? t("agentPanel.payg.title") : kind === "plan" ? t("agentPanel.plan.title") : t("agentPanel.plan.generic")}
          </div>
          {loading && !usage && <div className="agent-insight-note">{t("common.checking")}</div>}
          {usage?.metrics.map((m, i) => {
            const warn = m.percent !== undefined && m.percent >= WARN_AT;
            const { label, detail, value } = metricText(m);
            return (
              <div key={i} className={`plugin-usage-metric${warn ? " plugin-usage-metric--warn" : ""}`}>
                <div className="plugin-usage-metric-top">
                  <span className="plugin-usage-metric-label">{label}</span>
                  {m.percent !== undefined ? (
                    <span className="plugin-usage-metric-pct">{Math.round(m.percent * 100)}%</span>
                  ) : (
                    value && <span className={`plugin-usage-metric-pct${m.kind === "model" ? " plugin-usage-metric-pct--text" : ""}`}>{value}</span>
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
                    onClick={() => window.dispatchEvent(new CustomEvent("flowcode:cli-login", { detail: { command: m.command, profile } }))}
                  >
                    {m.kind === "noApiKey" ? t("usage.setup") : t("usage.login")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="agent-insight-section">
        <div className="agent-insight-title">{t("agentPanel.session.title")}</div>
        <SessionBlock session={session} showCost={kind === "payg"} />
      </div>
    </>
  );
}

function SessionBlock({ session, showCost }: { session: Loaded<SessionUsage>; showCost: boolean }) {
  const { t } = useI18n();
  if (session === undefined) return null;
  if (session === null) return <div className="agent-insight-note">{t("agentPanel.session.unavailable")}</div>;
  const hit = cacheHitRatio(session);
  const spark = sparkBars(session.turns);
  return (
    <>
      <Row name={t("agentPanel.session.input")} value={formatTokens(session.input)} />
      <Row name={t("agentPanel.session.output")} value={formatTokens(session.output)} />
      <Row name={t("agentPanel.session.cacheWrite")} value={formatTokens(session.cacheWrite)} />
      <Row name={t("agentPanel.session.cacheRead")} value={formatTokens(session.cacheRead)} />
      {hit !== null && <Row name={t("agentPanel.session.cacheHit")} value={`${Math.round(hit * 100)}%`} />}
      {spark.heights.length > 0 && (
        <>
          <div className="agent-insight-subtitle">{t("agentPanel.session.perTurn")}</div>
          <div className="agent-insight-spark">
            {spark.heights.map((h, i) => (
              <i key={i} className={i === spark.max ? "is-hi" : undefined} style={{ height: `${h}%` }} title={formatTokens(session.turns[i])} />
            ))}
          </div>
        </>
      )}
      {showCost && session.cost !== null && (
        <div className="agent-insight-cost">
          <span className="agent-insight-muted">{t("agentPanel.session.cost")}</span>
          <b>{`$${session.cost.toFixed(2)}`}</b>
          <span className="agent-insight-note">{t("agentPanel.session.costNote")}</span>
        </div>
      )}
    </>
  );
}

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="agents-sidebar-close agent-insight-refresh"
      title={t("agentPanel.tools.refresh")}
      aria-label={t("agentPanel.tools.refresh")}
      onClick={onRefresh}
    >
      <RefreshIcon />
    </button>
  );
}
