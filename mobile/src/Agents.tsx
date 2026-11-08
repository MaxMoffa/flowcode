import { useEffect, useMemo, useRef, useState } from "react";
import { contextPercent, shortCwd } from "./common";
import { t } from "./i18n";
import { requestOpenChat } from "./chats";
import { AgentLogo, ChatIcon } from "./icons";
import { money } from "./homeUsage";
import { useRemoteSelector, type ChatInfo, type Tab, type UsageItem, type UsageMetric } from "./remote";
import { ProviderUsageAuth } from "./ProviderUsageAuth";

/** Every limit gauge (5-hour session, weekly...) gets its own row. */
function gaugeMetrics(item: UsageItem): UsageMetric[] {
  return item.metrics.filter((m) => typeof m.percent === "number");
}

function UsageCard({ item }: { item: UsageItem }) {
  const gauges = gaugeMetrics(item);
  const spend = item.metrics.filter((m) => m.kind === "spend" && typeof m.cost === "number");
  // Anything without a number (logged out, unavailable...) shows its own wording.
  const note = gauges.length === 0 && spend.length === 0 ? item.metrics.find((m) => m.label)?.label : undefined;
  return (
    <div className="card usage">
      <div className="usage-title">{item.label}</div>
      {gauges.map((m, i) => {
        const pct = Math.round((m.percent ?? 0) * 100);
        return (
          <div className="usage-gauge" key={i}>
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
      {note && <div className="usage-sub">{note}</div>}
      <ProviderUsageAuth item={item} />
    </div>
  );
}

export interface ProfileGroup {
  key: string;
  title: string;
  color?: string;
  items: UsageItem[];
}

const AGENT_ORDER = ["claude-code", "codex-cli", "mistral-vibe", "gemini-cli", "opencode"];

/** Usage plugin of each agent CLI (`Tab.cli`). */
const PLUGIN_OF: Record<string, string> = { claude: "claude-code", codex: "codex-cli", vibe: "mistral-vibe", gemini: "gemini-cli", opencode: "opencode" };

/** The agent CLI (`Tab.cli`) of each usage plugin. */
export const CLI_OF: Record<string, string> = Object.fromEntries(Object.entries(PLUGIN_OF).map(([cli, plugin]) => [plugin, cli]));

/** `focus`: the agent of the terminal being viewed - its profile's group leads, and its card leads every group. */
export function groupByProfile(usage: UsageItem[], focus?: { plugin: string; profile: string }): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const u of usage) {
    const key = u.profile ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { key, title: key ? (u.profileName ?? key) : t("defaultProfile"), color: u.profileColor, items: [] };
      groups.set(key, g);
    }
    g.color ??= u.profileColor;
    g.items.push(u);
  }
  const order = (id: string) => {
    if (id === focus?.plugin) return -1;
    const i = AGENT_ORDER.indexOf(id);
    return i < 0 ? AGENT_ORDER.length : i;
  };
  for (const g of groups.values()) g.items.sort((x, y) => order(x.pluginId) - order(y.pluginId));
  // The viewed agent's profile leads, then the default one, then the named ones in arrival order.
  const rank = (g: ProfileGroup) => (focus && g.key === focus.profile && g.items.some((u) => u.pluginId === focus.plugin) ? -2 : g.key === "" ? -1 : 0);
  return [...groups.values()].sort((x, y) => rank(x) - rank(y));
}

/** One profile's cards in a snap-scrolling row, with pager dots synced to the scroll position. */
function UsageCarousel({ group }: { group: ProfileGroup }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const count = group.items.length;

  useEffect(() => {
    const row = rowRef.current;
    if (!row || count < 2) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const cards = Array.from(row.children) as HTMLElement[];
      let idx = 0;
      if (row.scrollLeft + row.clientWidth >= row.scrollWidth - 2) {
        idx = cards.length - 1;
      } else {
        const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
        let best = Infinity;
        cards.forEach((c, i) => {
          const d = Math.abs(c.offsetLeft - pad - row.scrollLeft);
          if (d < best) {
            best = d;
            idx = i;
          }
        });
      }
      setActive(idx);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    row.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      row.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [count]);

  const goTo = (i: number) => {
    const row = rowRef.current;
    const card = row?.children[i] as HTMLElement | undefined;
    if (!row || !card) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
    row.scrollTo({ left: card.offsetLeft - pad, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <>
      <div className={"usage-row" + (count < 2 ? " single" : "")} ref={rowRef} role="group" aria-label={group.title}>
        {group.items.map((u) => (
          <UsageCard key={u.pluginId + (u.profile ?? "")} item={u} />
        ))}
      </div>
      {count > 1 && (
        <div className="usage-pager">
          {group.items.map((u, i) => (
            <button
              key={u.pluginId + (u.profile ?? "")}
              type="button"
              className={"usage-dot" + (i === active ? " on" : "")}
              aria-label={t("showUsageOf", { name: u.label })}
              aria-current={i === active ? "true" : undefined}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Meta({ tab }: { tab: Tab }) {
  const ctx = contextPercent(tab);
  return (
    <span className="mono agent-meta">
      {tab.cli}
      {ctx !== null ? ` · ctx ${ctx}%` : ""}
    </span>
  );
}

const chatState = (chat: ChatInfo) => (chat.status === "waiting" ? "waiting" : chat.status === "busy" ? "busy" : "idle");

/** The wide layout's agent row for a chat session: the agent's logo with a bubble, folder, status chip. */
function ChatAgentRow({ chat, active }: { chat: ChatInfo; active: boolean }) {
  const st = chatState(chat);
  return (
    <button type="button" className={"ag-row" + (active ? " on" : "")} onClick={() => requestOpenChat(chat.chatId)}>
      <span className="ag-logo">
        <AgentLogo cli={chat.agent} size={16} />
      </span>
      <span className="ag-body">
        <b className="ag-name">{chat.label}</b>
        <span className="ag-path mono">{shortCwd(chat.cwd)}</span>
        <span className="ag-line">
          <span className={"ag-chip " + st}>{st === "waiting" ? t("statusWaiting") : st === "busy" ? t("statusBusy") : t("statusIdle")}</span>
          <ChatIcon size={13} />
        </span>
      </span>
    </button>
  );
}

/** The wide layout's agent row, as in the desktop's agents sidebar: logo tile, name, folder, status chip and CLI / context. */
function AgentRow({ tab, active, onOpen }: { tab: Tab; active: boolean; onOpen: (ptyId: string) => void }) {
  const st = tab.status ?? "idle";
  return (
    <button type="button" className={"ag-row" + (active ? " on" : "")} onClick={() => onOpen(tab.ptyId)}>
      <span className="ag-logo">{tab.cli && <AgentLogo cli={tab.cli} size={16} />}</span>
      <span className="ag-body">
        <b className="ag-name">{tab.label}</b>
        <span className="ag-path mono">{shortCwd(tab.cwd)}</span>
        <span className="ag-line">
          <span className={"ag-chip " + st}>{st === "waiting" ? t("statusWaiting") : st === "busy" ? t("statusBusy") : t("statusIdle")}</span>
          <Meta tab={tab} />
        </span>
      </span>
    </button>
  );
}

/** The wide layout's side card: its own header holds the title and the computer switcher is in the top bar. Agents are rows, with the shown one (`activePty` / `activeChat`) marked. */
export function AgentsScreen({ tabs, onOpen, activePty, activeChat }: { tabs: Tab[] | null; onOpen: (ptyId: string) => void; activePty?: string | null; activeChat?: string | null }) {
  const usage = useRemoteSelector((r) => r.usage);
  const chats = useRemoteSelector((r) => r.chats);
  const waitingChats = useMemo(() => (chats ?? []).filter((c) => c.status === "waiting"), [chats]);
  const otherChats = useMemo(() => (chats ?? []).filter((c) => c.status !== "waiting"), [chats]);
  const chatCount = chats?.length ?? 0;
  const { waiting, others } = useMemo(() => {
    const agents = (tabs ?? []).filter((x) => x.cli);
    return { waiting: agents.filter((x) => x.status === "waiting"), others: agents.filter((x) => x.status !== "waiting") };
  }, [tabs]);
  const active = activePty ? tabs?.find((x) => x.ptyId === activePty) : undefined;
  const focusPlugin = active?.cli ? PLUGIN_OF[active.cli] : undefined;
  const focusProfile = active?.profile ?? "";
  const groups = useMemo(() => groupByProfile(usage, focusPlugin ? { plugin: focusPlugin, profile: focusProfile } : undefined), [usage, focusPlugin, focusProfile]);
  return (
    <>
      {waiting.length + others.length + chatCount > 0 && (
        <section className="ag-section">
          <div className="gh">{t("thisComputer")}</div>
          {waitingChats.map((c) => (
            <ChatAgentRow key={c.chatId} chat={c} active={c.chatId === activeChat} />
          ))}
          {[...waiting, ...others].map((x) => (
            <AgentRow key={x.ptyId} tab={x} active={x.ptyId === activePty} onOpen={onOpen} />
          ))}
          {otherChats.map((c) => (
            <ChatAgentRow key={c.chatId} chat={c} active={c.chatId === activeChat} />
          ))}
        </section>
      )}
      {groups.map((g) => (
        <section className="usage-section" key={g.key}>
          <div className="gh usage-group">
            {g.color && <i className="dot" style={{ background: g.color }} />}
            {g.title}
          </div>
          <UsageCarousel group={g} />
        </section>
      ))}
      {tabs !== null && waiting.length + others.length + chatCount === 0 && <div className="empty">{t("noAgents")}</div>}
    </>
  );
}
