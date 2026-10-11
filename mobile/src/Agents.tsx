import { StatusPill, contextPercent } from "./common";
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
  const title = item.profile ? `${item.label} · ${item.profile}` : item.label;
  // Anything without a number (logged out, unavailable...) shows its own wording.
  const note = gauges.length === 0 && spend.length === 0 ? item.metrics.find((m) => m.label)?.label : undefined;
  return (
    <div className="card usage">
      <div className="usage-title">{title}</div>
      {gauges.map((m, i) => {
        const pct = Math.round((m.percent ?? 0) * 100);
        return (
          <div className="usage-gauge" key={i}>
            <div className="usage-head">
              <span className="usage-label">{m.label}</span>
              <span className="usage-pct">
                {pct}
                <small>%</small>
              </span>
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

function AgentCard({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  const ctx = contextPercent(tab);
  const waiting = tab.status === "waiting";
  return (
    <div className={"card agent" + (waiting ? " is-waiting" : "")}>
      <button type="button" className="agent-main" onClick={() => onOpen(tab.ptyId)}>
        <div className="agent-top">
          <span className="agent-label">{tab.label}</span>
          <StatusPill status={tab.status} />
        </div>
        <div className="agent-meta">
          <span className="mono">{tab.cli}</span>
          {ctx !== null && <span>{t("context", { pct: ctx })}</span>}
        </div>
      </button>
      {waiting && (
        <div className="quick">
          <button type="button" className="btn accent" onClick={() => send({ t: "input", ptyId: tab.ptyId, data: "1" })}>
            {t("yes")}
          </button>
          <button type="button" className="btn" onClick={() => send({ t: "input", ptyId: tab.ptyId, data: "\x1b" })}>
            {t("no")}
          </button>
          <button type="button" className="btn ghost" onClick={() => onOpen(tab.ptyId)}>
            {t("open")}
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentsScreen({ hostName, tabs, usage, onOpen }: { hostName?: string; tabs: Tab[] | null; usage: UsageItem[]; onOpen: (ptyId: string) => void }) {
  const agents = (tabs ?? []).filter((x) => x.cli);
  // Waiting agents first: they are why the phone is out of the pocket.
  const rank = (x: Tab) => (x.status === "waiting" ? 0 : x.status === "busy" ? 1 : 2);
  agents.sort((a, b) => rank(a) - rank(b));
  return (
    <>
      <header className="top">
        <div className="eyebrow">{t("connectedTo", { host: hostName ?? "..." })}</div>
        <h1>{t("agents")}</h1>
      </header>
      {usage.length > 0 && (
        <div className="stack">
          {usage.map((u) => (
            <UsageCard key={u.pluginId + (u.profile ?? "")} item={u} />
          ))}
        </div>
      )}
      <div className="stack">
        {agents.map((x) => (
          <AgentCard key={x.ptyId} tab={x} onOpen={onOpen} />
        ))}
        {tabs !== null && agents.length === 0 && <div className="empty">{t("noAgents")}</div>}
      </div>
    </>
  );
}
