import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerMsg, UsageItem } from "../../shared/remote-types";
import { useI18n } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import { formatTokens, modelDisplayName, type UsageMetric } from "../plugins/usage";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { ContextPane, ContextRing, InsightTabs, PlanMetrics, SessionBlock, type Tab } from "../agents/AgentInsightPanel";
import { planKind, type AgentTools, type SessionUsage } from "../agents/insightMath";
import { onHostMessages, sendToHost, useHost } from "./remoteHosts";
import "../agents/agents-sidebar.css";
import "../agents/agent-insight.css";
import "./remote-files.css";

interface Insight {
  context?: { used: number; window: number; model?: string } | null;
  usage?: SessionUsage | null;
  tools?: AgentTools | null;
}

const POLL_MS = 10_000;
const WARN_AT = 0.75;
/** Pause between typing a slash command and its Enter, so the TUI doesn't take the burst for a paste. */
const SUBMIT_DELAY_MS = 250;
const COMPACT_FEEDBACK_MS = 2500;

/** The usage items the other PC reports (plan limits per agent and profile): the ones it last sent, then as they change. */
function useHostUsage(hostId: string): UsageItem[] {
  const [items, setItems] = useState<UsageItem[]>([]);
  useEffect(() => {
    let alive = true;
    const fold = (msgs: ServerMsg[]) => {
      for (const m of msgs) if (m.t === "usage" && alive) setItems(m.items);
    };
    const stop = onHostMessages(hostId, fold);
    invoke<ServerMsg[]>("remote_host_cached", { id: hostId }).then(fold, () => {});
    return () => {
      alive = false;
      stop();
    };
  }, [hostId]);
  return items;
}

/** What the panel is about: the agent in front on the other PC. */
export interface RemoteAgentTarget {
  chatId?: string;
  ptyId?: string;
  cli: AgentCli;
  profile?: string;
  /** `busy` turns "compact" off: the command would queue behind the turn. */
  busy: boolean;
  /** The tab's name, as the local panel's subtitle. */
  label: string;
}

/** The agent in front on another PC, as the local Agent panel shows its own: context fill with "compact", the context
 * breakdown (memory, skills, conversation) with its tools, and the plan limits and session usage, as that PC reports
 * them (`agentinsight`, `usage`). Read-only apart from compacting. */
export function RemoteAgentPanel({ hostId, target }: { hostId: string; target: RemoteAgentTarget }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const usageItems = useHostUsage(hostId);
  const [insight, setInsight] = useState<Insight | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("context");
  const [sent, setSent] = useState(false);
  const { chatId, ptyId, cli, profile } = target;
  const key = chatId ?? ptyId ?? "";
  const supported = !!host?.caps.includes("agentInsight");
  const online = host?.status === "online";
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setInsight(undefined);
    if (!supported || !online || !key) return;
    const ask = () => void sendToHost(hostId, chatId ? { t: "agentinsight", chatId } : { t: "agentinsight", ptyId: key });
    ask();
    const timer = setInterval(() => document.visibilityState === "visible" && ask(), POLL_MS);
    const stop = onHostMessages(hostId, (msgs: ServerMsg[]) => {
      for (const m of msgs) if (m.t === "agentinsight" && m.key === key) setInsight({ context: m.context, usage: m.usage, tools: m.tools });
    });
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [hostId, key, chatId, supported, online, nonce]);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(false), COMPACT_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const compact = useCallback(async () => {
    setSent(true);
    if (chatId) {
      await sendToHost(hostId, { t: "chatprompt", chatId, text: "/compact" });
    } else if (ptyId) {
      await sendToHost(hostId, { t: "input", ptyId, data: "/compact" });
      await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
      await sendToHost(hostId, { t: "input", ptyId, data: "\r" });
    }
  }, [hostId, chatId, ptyId]);

  if (!supported) return <div className="remote-agent">{t("agentPanel.ctx.unsupported")}</div>;
  if (insight === undefined) return <div className="remote-agent">{t("common.loading")}</div>;

  const context = insight?.context ?? null;
  const percent = context && context.window > 0 ? Math.min(1, context.used / context.window) : null;
  const warn = percent !== null && percent >= WARN_AT;
  const pluginId = CLI_INFO[cli]?.pluginId ?? "";
  const plan = usageItems.find((u) => u.pluginId === pluginId && (u.profile ?? "") === (profile ?? ""));
  // The wire carries `kind` as a plain string (a newer PC may send kinds this one lacks); `metricText` shows unknown ones as they are.
  const metrics = (plan?.metrics ?? []) as UsageMetric[];
  const kind = plan ? planKind(metrics) : "other";
  const name = CLI_INFO[cli]?.name ?? cli;
  const model = context?.model ?? insight?.usage?.model ?? undefined;
  const subtitle = [model && modelDisplayName(model), chatId ? t("agentPanel.chat") : t("agentPanel.terminal"), target.label].filter(Boolean).join(" · ");

  return (
    <div className="agents-sidebar agent-insight">
      <div className="agent-insight-body">
        <div className="agent-insight-top">
          <div className="agent-insight-head">
            <span className="agent-insight-avatar" aria-hidden="true">{agentCliIcon(cli)}</span>
            <div className="agent-insight-who">
              <b title={name}>{name}</b>
              <small title={subtitle}>{subtitle}</small>
            </div>
          </div>
          <div className="agent-insight-ctx">
            <ContextRing percent={percent} warn={warn} />
            <div className="agent-insight-ctx-info">
              {context ? (
                <>
                  <b>{t("agentPanel.ofWindow", { used: formatTokens(context.used), window: formatTokens(context.window) })}</b>
                  <span className="agent-insight-muted">{t("agentPanel.free", { n: formatTokens(Math.max(0, context.window - context.used)) })}</span>
                </>
              ) : (
                <span className="agent-insight-muted">{t("agentPanel.ctx.noSession")}</span>
              )}
              <div>
                <button
                  type="button"
                  className="agent-insight-btn"
                  disabled={target.busy || sent || !online}
                  title={target.busy ? t("usage.context.compactBusy") : sent ? t("usage.context.compactSent") : t("usage.context.compact")}
                  onClick={() => void compact()}
                >
                  {t("agentPanel.compact")}
                </button>
              </div>
            </div>
          </div>
          <InsightTabs
            ariaLabel={t("agentPanel.tabs")}
            value={tab}
            onChange={setTab}
            options={[
              { id: "context", label: t("agentPanel.tab.context") },
              { id: "usage", label: t("agentPanel.tab.usage") },
            ]}
          />
        </div>
        <div className="agent-insight-pane" role="tabpanel">
          {tab === "context" && (
            <ContextPane
              ctx={context ? { used: context.used, window: context.window, windowEstimated: false, model: context.model ?? null } : null}
              tools={insight?.tools}
              toolsSupported
              onRefresh={() => setNonce((n) => n + 1)}
              warn={warn}
            />
          )}
          {tab === "usage" && (
            <>
              {plan && (
                <div className="agent-insight-section">
                  <div className="agent-insight-title">{kind === "payg" ? t("agentPanel.payg.title") : kind === "plan" ? t("agentPanel.plan.title") : t("agentPanel.plan.generic")}</div>
                  {/* Signing in happens on that PC: no buttons for it here. */}
                  <PlanMetrics metrics={metrics} canLogin={false} />
                </div>
              )}
              <div className="agent-insight-section">
                <div className="agent-insight-title">{t("agentPanel.session.title")}</div>
                <SessionBlock session={insight?.usage ?? null} showCost={kind === "payg"} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
