import { useMemo } from "react";
import logo from "./assets/flowcode-icon.svg";
import { contextPercent } from "./common";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { send, type Tab, type UsageItem, type UsageMetric } from "./remote";

/** Every limit gauge (5-hour session, weekly...) gets its own row. */
function gaugeMetrics(item: UsageItem): UsageMetric[] {
  return item.metrics.filter((m) => typeof m.percent === "number");
}

function money(v: number): string {
  return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
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
    </div>
  );
}

interface ProfileGroup {
  key: string;
  title: string;
  color?: string;
  items: UsageItem[];
}

const AGENT_ORDER = ["claude-code", "codex-cli", "mistral-vibe"];

function groupByProfile(usage: UsageItem[]): ProfileGroup[] {
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
    const i = AGENT_ORDER.indexOf(id);
    return i < 0 ? AGENT_ORDER.length : i;
  };
  for (const g of groups.values()) g.items.sort((x, y) => order(x.pluginId) - order(y.pluginId));
  // The default profile leads, the named ones follow in arrival order.
  return [...groups.values()].sort((x, y) => (x.key === "" ? -1 : 0) - (y.key === "" ? -1 : 0));
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

function WaitingRow({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  return (
    <button type="button" className="card tile is-waiting" onClick={() => onOpen(tab.ptyId)}>
      <span className="tile-head">
        <i className="dot wait" />
        <b>{tab.label}</b>
      </span>
      <Meta tab={tab} />
    </button>
  );
}

function Hero({ tab, count, onOpen }: { tab: Tab; count: number; onOpen: (ptyId: string) => void }) {
  return (
    <section className="card hero">
      <span className="hero-eyebrow">{count === 1 ? t("waitingOne") : t("waitingMany", { n: count })}</span>
      <div className="hero-title">{tab.label}</div>
      <Meta tab={tab} />
      <div className="hero-actions">
        <button
          type="button"
          className="btn big accent hero-btn"
          onClick={() => {
            tapFeedback();
            send({ t: "input", ptyId: tab.ptyId, data: "1" });
          }}
        >
          {t("yes")}
        </button>
        <button
          type="button"
          className="btn big hero-btn"
          onClick={() => {
            tapFeedback();
            send({ t: "input", ptyId: tab.ptyId, data: "\x1b" });
          }}
        >
          {t("no")}
        </button>
      </div>
      <button type="button" className="hero-link" onClick={() => onOpen(tab.ptyId)}>
        {t("openTerminal")}
      </button>
    </section>
  );
}

function AgentTile({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  const st = tab.status ?? "idle";
  const text = st === "busy" ? t("statusBusy") : t("statusIdle");
  return (
    <button type="button" className="card tile" onClick={() => onOpen(tab.ptyId)}>
      <span className="tile-head">
        <i className={"dot " + st} />
        <b>{tab.label}</b>
      </span>
      <span className={"tile-status " + st}>{text}</span>
      <Meta tab={tab} />
    </button>
  );
}

export function AgentsScreen({ hostName, tabs, usage, onOpen }: { hostName?: string; tabs: Tab[] | null; usage: UsageItem[]; onOpen: (ptyId: string) => void }) {
  const { waiting, others } = useMemo(() => {
    const agents = (tabs ?? []).filter((x) => x.cli);
    return { waiting: agents.filter((x) => x.status === "waiting"), others: agents.filter((x) => x.status !== "waiting") };
  }, [tabs]);
  const groups = useMemo(() => groupByProfile(usage), [usage]);
  return (
    <>
      <header className="agents-head">
        <img src={logo} alt="" />
        <span className="agents-host">
          Flowcode <span>· {hostName ?? "..."}</span>
        </span>
        <span className="agents-online">
          <i className="dot idle on" />
          {t("onlineShort")}
        </span>
      </header>
      {waiting.length > 0 && (
        <div className="stack">
          <Hero tab={waiting[0]} count={waiting.length} onOpen={onOpen} />
          {waiting.slice(1).map((x) => (
            <WaitingRow key={x.ptyId} tab={x} onOpen={onOpen} />
          ))}
        </div>
      )}
      {groups.map((g) => (
        <section className="usage-section" key={g.key}>
          <div className="gh usage-group">
            {g.color && <i className="dot" style={{ background: g.color }} />}
            {g.title}
          </div>
          <div className="usage-grid">
            {g.items.map((u) => (
              <UsageCard key={u.pluginId + (u.profile ?? "")} item={u} />
            ))}
          </div>
        </section>
      ))}
      {others.length > 0 && (
        <div className="tile-grid">
          {others.map((x) => (
            <AgentTile key={x.ptyId} tab={x} onOpen={onOpen} />
          ))}
        </div>
      )}
      {tabs !== null && waiting.length + others.length === 0 && <div className="empty">{t("noAgents")}</div>}
    </>
  );
}
