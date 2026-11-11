import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { delegatesOf } from "../../src/chat/chatModel";
import { activeCount } from "../../src/agents/delegateView";
import { cacheHitRatio, contextSegments, estTokensOfChars, planKind, sparkBars } from "../../src/agents/insightMath";
import type { AgentSessionUsage, AgentToolsInfo } from "../../shared/remote-types";
import { useAgentInsight, type AgentInsightReply, type InsightTarget } from "./insightStore";
import "./agent-insight.css";
import { DelegateRow } from "./ChatDelegates";
import { emptySession } from "./chatSession";
import { sendChatPrompt, useChatInfo, useChatSession } from "./chats";
import { agentName } from "./common";
import { t } from "./i18n";
import { send, useRemoteSelector, useSupports, type UsageItem } from "./remote";
import { safeStorage } from "./store";

const TABS = ["context", "usage", "delegates"] as const;
type PanelTab = (typeof TABS)[number];
const TAB_KEY = "flowcode.agentPanel.tab";
const WARN_AT = 0.75;
/** Pause between typing a slash command and its Enter, so the TUI doesn't take the burst for a paste. */
const SUBMIT_DELAY_MS = 250;
const COMPACT_FEEDBACK_MS = 2500;

/** Usage plugin of each agent CLI. */
const PLUGIN_OF: Record<string, string> = { claude: "claude-code", codex: "codex-cli", vibe: "mistral-vibe", gemini: "gemini-cli", opencode: "opencode" };

interface Ctx {
  used: number;
  window: number;
  model?: string;
}

/** "1.2M" / "850K" / "920" tokens. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** "claude-opus-4-5-20251101" -> "Claude Opus 4.5"; other ids as they are. */
function modelDisplayName(id: string): string {
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) {
    const [, family, major, minor] = claude;
    return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  }
  if (/^gpt-/i.test(id)) return id.split("-").map((p, i) => (i === 0 ? "GPT" : p ? p[0].toUpperCase() + p.slice(1) : p)).join("-");
  return id;
}

function readTab(): PanelTab {
  const v = safeStorage.get(TAB_KEY);
  return (TABS as readonly string[]).includes(v ?? "") ? (v as PanelTab) : "context";
}

function RobotIcon() {
  return (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
    </svg>
  );
}

/** The panel of the agent in front: a terminal tab (`ptyId`) or a chat (`chatId`). `open` gates the polling. */
export function AgentInsight({ ptyId, chatId, open, onOpenChat }: { ptyId?: string; chatId?: string; open: boolean; onOpenChat?: (chatId: string) => void }) {
  const tab = useRemoteSelector((s) => (ptyId ? s.tabs?.find((x) => x.ptyId === ptyId) : undefined));
  const chat = useChatInfo(chatId ?? null);
  const cli = chatId ? chat?.agent : tab?.cli;
  const hasAgent = !!cli && (chatId ? !!chat : !!tab);
  const target: InsightTarget = chatId ? { chatId } : { ptyId: ptyId ?? "" };
  const reply = useAgentInsight(target, open && hasAgent);
  const supported = useSupports("agentInsight");

  if (!hasAgent || !cli) {
    return (
      <div className="ai-empty">
        <RobotIcon />
        <b>{t("agentPanelEmpty")}</b>
        <span>{t("agentPanelEmptyHint")}</span>
      </div>
    );
  }
  const profile = chatId ? chat?.profile : tab?.profile;
  const status = chatId ? chat?.status : tab?.status;
  const context = (chatId ? reply?.context : (reply?.context ?? tab?.context)) ?? null;
  return <Body cli={cli} profile={profile} status={status} chatId={chatId} ptyId={ptyId} context={context} reply={reply} supported={supported} onOpenChat={onOpenChat} />;
}

function Body({ cli, profile, status, chatId, ptyId, context, reply, supported, onOpenChat }: { cli: string; profile?: string; status?: string; chatId?: string; ptyId?: string; context: Ctx | null; reply?: AgentInsightReply; supported: boolean; onOpenChat?: (chatId: string) => void }) {
  const [stored, setTab] = useState<PanelTab>(readTab);
  // Terminals have no delegations: a stored "delegates" reads as "context" there.
  const tabs = TABS.filter((id) => id !== "delegates" || !!chatId);
  const tab = tabs.includes(stored) ? stored : "context";
  const pick = (v: PanelTab) => {
    setTab(v);
    safeStorage.set(TAB_KEY, v);
  };
  const percent = context && context.window > 0 ? Math.min(1, context.used / context.window) : null;
  const warn = percent !== null && percent >= WARN_AT;
  const model = context?.model ?? reply?.usage?.model ?? undefined;
  const chip = [agentName(cli), model && modelDisplayName(model), chatId ? t("agentChat") : t("agentTerminal")].filter(Boolean).join(" · ");
  const label: Record<PanelTab, string> = { context: t("agentTabContext"), usage: t("agentTabUsage"), delegates: t("agentTabDelegates") };
  return (
    <div className="ai">
      <div className="ai-top">
        <div className="ai-chip" title={chip}>
          {chip}
        </div>
        <div className="ai-hero">
          <span className={"ai-big" + (warn ? " warn" : "")}>{percent === null ? "—" : `${Math.round(percent * 100)}%`}</span>
          <span className="ai-detail">{context ? t("agentCtxOf", { used: formatTokens(context.used), window: formatTokens(context.window) }) : t("agentCtxUnknown")}</span>
          <CompactButton chatId={chatId} ptyId={ptyId} busy={status === "busy"} />
        </div>
        <div className={"ai-meter" + (warn ? " warn" : "")}>
          <i style={{ width: `${Math.round((percent ?? 0) * 100)}%` }} />
        </div>
        <div className="seg" role="tablist" aria-label={t("agentTabs")}>
          {tabs.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => pick(id)}>
              {label[id]}
            </button>
          ))}
        </div>
      </div>
      <div className="ai-pane" role="tabpanel">
        {tab === "context" && <ContextPane context={context} tools={reply?.tools} loaded={reply !== undefined} supported={supported} warn={warn} />}
        {tab === "usage" && <UsagePane cli={cli} profile={profile} session={reply?.usage} loaded={reply !== undefined} supported={supported} />}
        {tab === "delegates" && chatId && <DelegatesPane chatId={chatId} onOpenChat={onOpenChat} />}
      </div>
    </div>
  );
}

/** Asks the agent to compact its context: typed into the terminal, or sent as a prompt in a chat. Off while the agent works. */
function CompactButton({ chatId, ptyId, busy }: { chatId?: string; ptyId?: string; busy: boolean }) {
  const [sent, setSent] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);
  const compact = () => {
    setSent(true);
    if (chatId) {
      sendChatPrompt(chatId, "/compact");
    } else if (ptyId) {
      send({ t: "input", ptyId, data: "/compact" });
      timers.current.push(setTimeout(() => send({ t: "input", ptyId, data: "\r" }), SUBMIT_DELAY_MS));
    }
    timers.current.push(setTimeout(() => setSent(false), COMPACT_FEEDBACK_MS));
  };
  return (
    <button type="button" className="ai-btn" disabled={busy || sent} title={busy ? t("agentCompactBusy") : undefined} onClick={compact}>
      {t("agentCompact")}
    </button>
  );
}

function Row({ swatch, name, value, title, muted }: { swatch?: ReactNode; name: ReactNode; value?: ReactNode; title?: string; muted?: boolean }) {
  return (
    <div className="ai-row" title={title}>
      {swatch}
      <span className={"ai-row-name" + (muted ? " muted" : "")}>{name}</span>
      {value !== undefined && <span className="ai-row-value">{value}</span>}
    </div>
  );
}

function ContextPane({ context, tools, loaded, supported, warn }: { context: Ctx | null; tools?: AgentToolsInfo | null; loaded: boolean; supported: boolean; warn: boolean }) {
  const toolsBlock = (
    <div className="ai-tools">
      <ToolsPane tools={tools} loaded={loaded} supported={supported} />
    </div>
  );
  if (!context || context.window <= 0) {
    return (
      <>
        <div className="ai-note">{t("agentCtxUnknown")}</div>
        {toolsBlock}
      </>
    );
  }
  const seg = contextSegments(context.used, context.window, tools?.memoryChars ?? 0, tools?.skills.reduce((n, s) => n + s.estTokens, 0) ?? 0);
  const items = [
    { key: "mem", color: "var(--c-mem)", name: t("agentCtxMemory"), n: seg.memory },
    { key: "skill", color: "var(--c-skill)", name: t("agentCtxSkills"), n: seg.skills },
    { key: "conv", color: "var(--c-msg)", name: t("agentCtxConversation"), n: seg.conversation },
  ];
  return (
    <>
      <div className="ai-stack">
        {items.map((i) => (
          <i key={i.key} style={{ width: `${(i.n / context.window) * 100}%`, background: i.color }} />
        ))}
      </div>
      {items.map((i) => (
        <Row key={i.key} swatch={<span className="ai-sw" style={{ background: i.color }} />} name={i.name} value={formatTokens(i.n)} />
      ))}
      <Row swatch={<span className="ai-sw free" />} name={t("agentCtxFree")} value={formatTokens(seg.free)} muted />
      {warn && <div className="ai-tip">{t("agentCtxFull")}</div>}
      {context.model && (
        <div className="ai-section" style={{ marginTop: 14 }}>
          <Row name={t("agentCtxModel")} value={modelDisplayName(context.model)} />
        </div>
      )}
      {toolsBlock}
    </>
  );
}

const money = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;

/** The plan limits (or pay-per-token spend) of the agent's account, from the usage the phone already mirrors. */
function PlanBlock({ item, kind }: { item: UsageItem; kind: ReturnType<typeof planKind> }) {
  const gauges = item.metrics.filter((m) => typeof m.percent === "number");
  const spend = item.metrics.filter((m) => m.kind === "spend" && typeof m.cost === "number");
  const note = gauges.length === 0 && spend.length === 0 ? item.metrics.find((m) => m.label)?.label : undefined;
  return (
    <div className="ai-section">
      <div className="ai-title">{kind === "payg" ? t("agentPaygTitle") : kind === "plan" ? t("agentPlanTitle") : t("agentPlanGeneric")}</div>
      {gauges.map((m, i) => {
        const pct = Math.round((m.percent ?? 0) * 100);
        return (
          <div className="ai-gauge" key={i}>
            <div className="usage-head">
              <span className="usage-label">{m.label}</span>
              <b className="usage-pct">{pct}%</b>
            </div>
            <div className={"bar" + (pct >= 90 ? " hot" : pct >= 70 ? " warm" : "")}>
              <i style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            {m.resets && <div className="usage-sub">{t("resets", { when: m.resets })}</div>}
          </div>
        );
      })}
      {spend.map((m, i) => (
        <div className="usage-spend" key={i}>
          <b>{money(m.cost ?? 0)}</b>
          <span>{m.label ?? m.period ?? ""}</span>
        </div>
      ))}
      {note && <div className="ai-note">{note}</div>}
    </div>
  );
}

function UsagePane({ cli, profile, session, loaded, supported }: { cli: string; profile?: string; session?: AgentSessionUsage | null; loaded: boolean; supported: boolean }) {
  const pluginId = PLUGIN_OF[cli] ?? "";
  const item = useRemoteSelector((s) => s.usage.find((u) => u.pluginId === pluginId && (u.profile ?? "") === (profile ?? "")));
  const kind = item ? planKind(item.metrics as Parameters<typeof planKind>[0]) : "other";
  return (
    <>
      {item && <PlanBlock item={item} kind={kind} />}
      <div className="ai-section">
        <div className="ai-title">{t("agentSessionTitle")}</div>
        {!supported ? (
          <div className="ai-note">{t("agentUpdateDesktop")}</div>
        ) : !loaded ? (
          <div className="ai-note">{t("agentChecking")}</div>
        ) : !session ? (
          <div className="ai-note">{t("agentSessionUnavailable")}</div>
        ) : (
          <SessionBlock session={session} showCost={kind === "payg"} />
        )}
      </div>
    </>
  );
}

function SessionBlock({ session, showCost }: { session: AgentSessionUsage; showCost: boolean }) {
  const hit = cacheHitRatio(session);
  const spark = sparkBars(session.turns);
  return (
    <>
      <Row name={t("agentSessionInput")} value={formatTokens(session.input)} />
      <Row name={t("agentSessionOutput")} value={formatTokens(session.output)} />
      <Row name={t("agentSessionCacheWrite")} value={formatTokens(session.cacheWrite)} />
      <Row name={t("agentSessionCacheRead")} value={formatTokens(session.cacheRead)} />
      {hit !== null && <Row name={t("agentSessionCacheHit")} value={`${Math.round(hit * 100)}%`} />}
      {spark.heights.length > 0 && (
        <>
          <div className="ai-title" style={{ marginTop: 10 }}>
            {t("agentSessionPerTurn")}
          </div>
          <div className="ai-spark">
            {spark.heights.map((h, i) => (
              <i key={i} className={i === spark.max ? "hi" : undefined} style={{ height: `${h}%` }} />
            ))}
          </div>
        </>
      )}
      {showCost && session.cost !== null && (
        <div className="ai-cost">
          <span className="ai-note">{t("agentSessionCost")}</span>
          <b>{`$${session.cost.toFixed(2)}`}</b>
          <span className="ai-note">{t("agentSessionCostNote")}</span>
        </div>
      )}
    </>
  );
}

function ToolsPane({ tools, loaded, supported }: { tools?: AgentToolsInfo | null; loaded: boolean; supported: boolean }) {
  if (!supported) return <div className="ai-note">{t("agentUpdateDesktop")}</div>;
  if (!loaded) return <div className="ai-note">{t("agentChecking")}</div>;
  if (!tools) return <div className="ai-note">{t("agentToolsUnavailable")}</div>;
  return (
    <>
      <div className="ai-section">
        <div className="ai-title">
          {t("agentToolsMcp")} <b>{tools.mcp.length}</b>
        </div>
        {tools.mcp.length === 0 && <div className="ai-note">{t("agentToolsNone")}</div>}
        {tools.mcp.map((m) => (
          <Row
            key={`${m.scope}:${m.name}`}
            name={m.name}
            title={m.target}
            value={
              <>
                <span className="ai-badge">{m.transport}</span> <span className="ai-badge">{m.scope}</span>
              </>
            }
          />
        ))}
      </div>
      <div className="ai-section">
        <div className="ai-title">
          {t("agentToolsSkills")} <b>{tools.skills.length}</b>
        </div>
        {tools.skills.length === 0 && <div className="ai-note">{t("agentToolsNone")}</div>}
        {tools.skills.map((s) => (
          <Row
            key={`${s.scope}:${s.name}`}
            name={s.name}
            value={
              <>
                <span className="ai-badge">{s.scope}</span> {t("agentToolsEst", { n: formatTokens(s.estTokens) })}
              </>
            }
          />
        ))}
      </div>
      <div className="ai-section">
        <div className="ai-title">{t("agentToolsMemory")}</div>
        <Row
          name={tools.memoryFiles.length > 0 ? tools.memoryFiles.map((f) => f.split(/[\\/]/).pop()).join(", ") : t("agentToolsNone")}
          title={tools.memoryFiles.join("\n")}
          value={t("agentToolsEst", { n: formatTokens(estTokensOfChars(tools.memoryChars)) })}
        />
      </div>
      <div className="ai-note">{t("agentToolsNote")}</div>
    </>
  );
}

/** The delegations of an orchestrator chat, or the request a delegated child chat answers. */
function DelegatesPane({ chatId, onOpenChat }: { chatId: string; onOpenChat?: (chatId: string) => void }) {
  const stored = useChatSession(chatId);
  const { model } = useMemo(() => stored ?? emptySession(), [stored]);
  const delegates = useMemo(() => delegatesOf(model.items), [model.items]);
  const task = model.task;
  if (task) {
    return (
      <div className="ai-section">
        <div className="ai-title">{t("agentDelegFrom", { agent: [agentName(task.parentAgent), task.parentTitle].filter(Boolean).join(" · ") })}</div>
        <div className="ai-prompt">{task.prompt}</div>
        {onOpenChat && (
          <button type="button" className="ai-btn ai-orch" onClick={() => onOpenChat(task.parentChatId)}>
            {t("agentDelegOpenOrch")}
          </button>
        )}
      </div>
    );
  }
  if (delegates.length === 0) return <div className="ai-note">{t("agentDelegEmpty")}</div>;
  const active = activeCount(delegates);
  return (
    <div className="ai-section">
      <div className="ai-title">
        {t("chatDelegateMany", { n: delegates.length })}
        {active > 0 && <b>{t("agentDelegActive", { n: active })}</b>}
      </div>
      {delegates.map((d) => (
        <DelegateRow key={d.taskId} d={d} onOpen={onOpenChat} />
      ))}
    </div>
  );
}
