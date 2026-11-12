import { useEffect, useMemo, useState } from "react";
import { planKind } from "../../src/agents/insightMath";
import { CLI_OF, groupByProfile } from "./Agents";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { formatTokens, leftText, money, pace, resetIn, spendSummary, usageTone, WINDOW_MS } from "./homeUsage";
import { t } from "./i18n";
import { AgentLogo } from "./icons";
import type { UsageItem, UsageMetric } from "./remote";
import { ProviderUsageAuth } from "./ProviderUsageAuth";

/** Re-reads the clock every minute so "resets in" and the tick move while the page stays open. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const PACE_TEXT = { over: "usageOverPace", under: "usageUnderPace", on: "usageOnPace" } as const;

function Header({ item, kind }: { item: UsageItem; kind: "plan" | "payg" | "other" }) {
  const kindText = kind === "plan" ? t("usageSub") : kind === "payg" ? t("usagePayg") : "";
  const profile = item.profile ? (item.profileName ?? item.profile) : "";
  return (
    <div className="hm-u-head">
      <span className="hm-u-ico">
        <AgentLogo cli={CLI_OF[item.pluginId] ?? ""} size={18} />
      </span>
      <span className="hm-u-name">
        <b>{item.label}</b>
        <small>
          {item.profile && <i className="dot" style={{ background: item.profileColor ?? "var(--muted)" }} />}
          {[profile, kindText].filter(Boolean).join(" · ")}
        </small>
      </span>
    </div>
  );
}

/** One limit window: the bar, a white tick where the time stands, when it resets and whether the pace is ahead of it. */
function Gauge({ metric, now }: { metric: UsageMetric; now: Date }) {
  const pct = Math.round((metric.percent ?? 0) * 100);
  const label = metric.label ?? "";
  const left = resetIn(metric.resets, now);
  const windowMs = WINDOW_MS[metric.kind];
  const known = windowMs !== undefined && left !== null ? pace(pct, left, windowMs) : null;
  const resetText = left !== null ? t("usageResetIn", { time: leftText(left) }) : metric.resets ? t("resets", { when: metric.resets }) : "";
  const aria = known ? t("usageBarLabel", { label, used: pct, elapsed: known.elapsed }) : t("usageBarUsed", { label, used: pct });
  return (
    <div className={"hm-u-g hm-" + (usageTone(pct) || "ok")}>
      <div className="hm-u-gt">
        <span>{label}</span>
        <b>{pct}%</b>
      </div>
      <div className="hm-u-bar" role="img" aria-label={aria}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
        {known && <s style={{ left: `${known.elapsed}%` }} />}
      </div>
      <div className="hm-u-gs">
        <span>{resetText}</span>
        {known && pct < 100 && <span className={known.state === "over" ? "up" : ""}>{t(PACE_TEXT[known.state])}</span>}
      </div>
    </div>
  );
}

function PlanBody({ item, now }: { item: UsageItem; now: Date }) {
  const gauges = item.metrics.filter((m) => typeof m.percent === "number");
  const hit = gauges.find((m) => Math.round((m.percent ?? 0) * 100) >= 100);
  const hitLeft = hit ? resetIn(hit.resets, now) : null;
  return (
    <>
      {hit && <div className="hm-u-alert">{hitLeft !== null ? t("usageLimitHitIn", { time: leftText(hitLeft) }) : t("usageLimitHit")}</div>}
      {gauges.map((m, i) => (
        <Gauge key={i} metric={m} now={now} />
      ))}
    </>
  );
}

function PaygBody({ item }: { item: UsageItem }) {
  const s = spendSummary(item.metrics);
  const unpriced = item.metrics.find((m) => m.kind === "unpriced" && m.label);
  const today = typeof s.today?.cost === "number" ? s.today.cost : null;
  const rows = [
    { label: t("usageTodayRow"), cost: today },
    { label: t("usageWeekRow"), cost: s.week?.cost ?? null },
    { label: t("usageMonthRow"), cost: s.month?.cost ?? null },
  ].filter((r): r is { label: string; cost: number } => typeof r.cost === "number");
  const top = Math.max(...rows.map((r) => r.cost), 0);
  const note =
    s.state === null || s.dailyAverage === null || s.ratio === null
      ? null
      : s.state === "over"
        ? t("usageAvgOver", { x: s.ratio.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), avg: money(s.dailyAverage) })
        : s.state === "under"
          ? t("usageAvgUnder")
          : t("usageAvgOn");
  const m = s.month;
  return (
    <>
      {today !== null && (
        <div className="hm-u-big">
          <b>{money(today)}</b>
          <span>{t("usageToday")}</span>
        </div>
      )}
      {note && <div className={"hm-u-note" + (s.state === "over" ? " up" : "")}>{note}</div>}
      {rows.length > 0 && (
        <div className="hm-nest">
          {rows.map((r) => (
            <div key={r.label}>
              <span>{r.label}</span>
              <span className="bar2">
                <i style={{ width: `${Math.max(2, top > 0 ? (r.cost / top) * 100 : 0)}%` }} />
              </span>
              <b>{money(r.cost)}</b>
            </div>
          ))}
        </div>
      )}
      {m && m.tokens !== undefined && m.sessions !== undefined && <div className="hm-u-note gap">{t("usageTotals", { tokens: formatTokens(m.tokens), sessions: m.sessions })}</div>}
      {unpriced?.label && <div className="hm-u-note gap">{unpriced.label}</div>}
    </>
  );
}

/** Nothing to measure (logged out, unavailable...): the CLI's own wording and, when it has one, the command that fixes it. */
function OtherBody({ item }: { item: UsageItem }) {
  const first = item.metrics.find((m) => m.label) ?? item.metrics[0];
  if (!first) return null;
  return (
    <div className="hm-u-off">
      {first.label && <b>{first.label}</b>}
      {first.command && <span>{t("usageRunCommand", { command: first.command })}</span>}
      <ProviderUsageAuth item={item} />
    </div>
  );
}

export function UsageCard({ item, now }: { item: UsageItem; now: Date }) {
  const kind = planKind(item.metrics as Parameters<typeof planKind>[0]);
  const gauges = item.metrics.filter((m) => typeof m.percent === "number").map((m) => Math.round((m.percent ?? 0) * 100));
  const cls = kind !== "plan" ? "" : gauges.some((p) => p >= 100) ? " hit" : gauges.some((p) => p >= 90) ? " warmc" : "";
  return (
    <article className={"hm-uc" + cls}>
      <Header item={item} kind={kind} />
      {kind === "plan" ? <PlanBody item={item} now={now} /> : kind === "payg" ? <PaygBody item={item} /> : <OtherBody item={item} />}
    </article>
  );
}

/** "Limiti e costi": a snapping row of one card per agent and profile, and a sheet listing them all. */
export function UsageSection({ items }: { items: UsageItem[] }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useBackHandler(open, close);
  useEscape(open, close);
  const ordered = useMemo(() => groupByProfile(items).flatMap((g) => g.items), [items]);
  if (ordered.length === 0) return null;
  return (
    <section className="hm-group">
      <div className="hm-sec">
        <b>{t("homeUsage")}</b>
        <button type="button" className="hm-sec-link" onClick={() => setOpen(true)}>
          {t("homeDetails")}
        </button>
      </div>
      <div className={"hm-ucards" + (ordered.length === 1 ? " single" : "")} role="group" aria-label={t("homeUsage")}>
        {ordered.map((item) => (
          <UsageCard key={item.pluginId + (item.profile ?? "")} item={item} now={now} />
        ))}
      </div>
      {open && (
        <AdaptiveSheet open family="nts" variant="dialog" onClose={close} label={t("homeUsage")}>
          <div className="nts-grab" aria-hidden="true" />
          <h2>{t("homeUsage")}</h2>
          <div className="nts-body">
            <div className="hm-sheet-list">
              {ordered.map((item) => (
                <UsageCard key={item.pluginId + (item.profile ?? "")} item={item} now={now} />
              ))}
            </div>
            <p className="hm-hint">{t("homeTickHint")}</p>
          </div>
        </AdaptiveSheet>
      )}
    </section>
  );
}
