import { useEffect, useState } from "react";
import type { AgentSessionUsage, AgentToolsInfo, ServerMsg } from "../../shared/remote-types";
import { useI18n } from "../i18n";
import { onHostMessages, sendToHost, useHost } from "./remoteHosts";
import "./remote-files.css";

interface Insight {
  context?: { used: number; window: number; model?: string } | null;
  usage?: AgentSessionUsage | null;
  tools?: AgentToolsInfo | null;
}

const POLL_MS = 10_000;
const WARN_AT = 0.75;

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));

/** The agent in front on another PC: its context fill, this session's usage and the tools it is configured with, as that PC reports them (`agentinsight`). Read-only. */
export function RemoteAgentPanel({ hostId, target }: { hostId: string; target: { chatId: string } | { ptyId: string } }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const [insight, setInsight] = useState<Insight | null | undefined>(undefined);
  const key = "chatId" in target ? target.chatId : target.ptyId;
  const supported = !!host?.caps.includes("agentInsight");
  const online = host?.status === "online";

  useEffect(() => {
    setInsight(undefined);
    if (!supported || !online) return;
    const ask = () => void sendToHost(hostId, "chatId" in target ? { t: "agentinsight", chatId: key } : { t: "agentinsight", ptyId: key });
    ask();
    const timer = setInterval(() => document.visibilityState === "visible" && ask(), POLL_MS);
    const stop = onHostMessages(hostId, (msgs: ServerMsg[]) => {
      for (const m of msgs) if (m.t === "agentinsight" && m.key === key) setInsight({ context: m.context, usage: m.usage, tools: m.tools });
    });
    return () => {
      clearInterval(timer);
      stop();
    };
    // `key` stands for the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, key, supported, online]);

  if (!supported) return <div className="remote-agent">{t("agentPanel.ctx.unsupported")}</div>;
  if (!insight) return <div className="remote-agent">{insight === undefined ? t("common.loading") : t("agentPanel.session.unavailable")}</div>;
  const { context, usage, tools } = insight;
  const percent = context && context.window > 0 ? Math.min(1, context.used / context.window) : null;
  const cache = usage && usage.cacheRead + usage.input > 0 ? usage.cacheRead / (usage.cacheRead + usage.input) : null;
  return (
    <div className="remote-agent agents-sidebar agent-insight">
      <section>
        <h4>{t("agentPanel.tab.context")}</h4>
        {context && percent !== null ? (
          <>
            <div className={"remote-agent-meter" + (percent >= WARN_AT ? " is-warn" : "")}>
              <span style={{ width: `${Math.round(percent * 100)}%` }} />
            </div>
            <div className="remote-agent-row">
              <span>{t("agentPanel.ofWindow", { used: tokens(context.used), window: tokens(context.window) })}</span>
              <span>{context.model ?? ""}</span>
            </div>
            {percent >= WARN_AT && <div>{t("agentPanel.ctx.full")}</div>}
          </>
        ) : (
          <div>{t("agentPanel.ctx.noSession")}</div>
        )}
      </section>
      <section>
        <h4>{t("agentPanel.session.title")}</h4>
        {usage ? (
          <>
            <div className="remote-agent-row"><span>{t("agentPanel.session.input")}</span><span>{tokens(usage.input)}</span></div>
            <div className="remote-agent-row"><span>{t("agentPanel.session.output")}</span><span>{tokens(usage.output)}</span></div>
            <div className="remote-agent-row"><span>{t("agentPanel.session.cacheWrite")}</span><span>{tokens(usage.cacheWrite)}</span></div>
            <div className="remote-agent-row"><span>{t("agentPanel.session.cacheRead")}</span><span>{tokens(usage.cacheRead)}</span></div>
            {cache !== null && <div className="remote-agent-row"><span>{t("agentPanel.session.cacheHit")}</span><span>{Math.round(cache * 100)}%</span></div>}
            {usage.cost !== null && <div className="remote-agent-row"><span>{t("agentPanel.session.cost")}</span><span>{`$${usage.cost.toFixed(2)}`}</span></div>}
          </>
        ) : (
          <div>{t("agentPanel.session.unavailable")}</div>
        )}
      </section>
      <section>
        <h4>{t("agentPanel.ctx.mcp")}</h4>
        {tools ? (
          <>
            {tools.mcp.length === 0 && <div>{t("agentPanel.tools.none")}</div>}
            {tools.mcp.map((m) => (
              <div key={`${m.scope}:${m.name}`} className="remote-agent-row" title={m.target}>
                <span>{m.name}</span>
                <span>{m.scope}</span>
              </div>
            ))}
          </>
        ) : (
          <div>{t("agentPanel.tools.unavailable")}</div>
        )}
      </section>
      {tools && tools.skills.length > 0 && (
        <section>
          <h4>{t("agentPanel.ctx.skills")}</h4>
          {tools.skills.map((s) => (
            <div key={`${s.scope}:${s.name}`} className="remote-agent-row">
              <span>{s.name}</span>
              <span>{t("agentPanel.tools.estTokens", { n: tokens(s.estTokens) })}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
