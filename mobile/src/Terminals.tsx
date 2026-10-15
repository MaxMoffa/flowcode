import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SWEEP_DASHES } from "../../shared/busySweep";
import { contextPercent, shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, ChevronIcon, PlusIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import type { Tab } from "./remote";

/** How long a requested terminal is waited for before giving up on opening it. */
const NEW_TAB_WAIT_MS = 15_000;

/** The arc running round a busy agent's icon, as on the desktop's tabs. */
export function BusyArc() {
  return (
    <svg className="tr-sweep" aria-hidden="true">
      {SWEEP_DASHES.map((d, i) => (
        <rect key={i} width="100%" height="100%" rx="9" pathLength="100" style={{ strokeDasharray: d.dasharray, opacity: d.opacity }} />
      ))}
    </svg>
  );
}

function stateLabel(st: string): string {
  return st === "waiting" ? t("statusWaiting") : st === "busy" ? t("statusBusy") : t("statusIdle");
}

function TermRow({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  const st = tab.cli ? (tab.status ?? "idle") : null;
  const pct = tab.cli ? contextPercent(tab) : null;
  return (
    <button type="button" className="tr-row" onClick={() => onOpen(tab.ptyId)}>
      <span className={"tr-ico" + (st ? " is-" + st : "")}>
        {(tab.cli && <AgentLogo cli={tab.cli} size={17} />) || <TerminalIcon />}
        {st === "busy" && <BusyArc />}
      </span>
      <span className="tr-body">
        <b className="tr-title">{tab.label}</b>
        {st ? (
          <span className="tr-line">
            <span className={"tr-state is-" + st}>{stateLabel(st)}</span>
            <span className="tr-sub mono">· {pct !== null ? t("contextPct", { n: pct }) : shortCwd(tab.cwd)}</span>
          </span>
        ) : (
          <span className="tr-sub mono">{shortCwd(tab.cwd)}</span>
        )}
      </span>
      <ChevronIcon />
    </button>
  );
}

/** The tabs by desktop window, the main one first; the others are numbered in the order the desktop lists them. */
function byWindow(tabs: Tab[]): { key: string; title: string; tabs: Tab[] }[] {
  const groups = new Map<string, Tab[]>();
  for (const tab of tabs) {
    const list = groups.get(tab.window);
    if (list) list.push(tab);
    else groups.set(tab.window, [tab]);
  }
  const entries = [...groups.entries()].sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : 0));
  let n = 1;
  return entries.map(([key, list]) => ({ key, title: key === "main" ? t("windowMain") : t("windowN", { n: ++n }), tabs: list }));
}

/** A requested terminal opens as soon as the desktop lists it; returns the `onCreate` callback for NewTerminalSheet. */
export function useOpenNewTab(tabs: Tab[] | null, onOpen: (ptyId: string) => void): () => void {
  /** The tabs known when asking, and until when to wait. */
  const pendingRef = useRef<{ known: Set<string>; until: number } | null>(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !tabs) return;
    if (Date.now() > p.until) {
      pendingRef.current = null;
      return;
    }
    const fresh = tabs.find((x) => !p.known.has(x.ptyId));
    if (fresh) {
      pendingRef.current = null;
      onOpen(fresh.ptyId);
    }
  }, [tabs, onOpen]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  return useCallback(() => {
    pendingRef.current = { known: new Set((tabsRef.current ?? []).map((x) => x.ptyId)), until: Date.now() + NEW_TAB_WAIT_MS };
  }, []);
}

export function TerminalsScreen({ hostName, tabs, onOpen }: { hostName?: string; tabs: Tab[] | null; onOpen: (ptyId: string) => void }) {
  const all = useMemo(() => tabs ?? [], [tabs]);
  const groups = useMemo(() => byWindow(all), [all]);
  const folders = useMemo(() => [...new Set(all.map((x) => x.cwd).filter(Boolean))], [all]);
  const [sheet, setSheet] = useState(false);
  const onCreate = useOpenNewTab(tabs, onOpen);

  return (
    <>
      <header className="th">
        <span className="th-text">
          <h1>{t("terminals")}</h1>
          {tabs !== null && (
            <span className="th-sub">
              {hostName ? `${hostName} · ` : ""}
              {all.length === 1 ? t("openCountOne") : t("openCount", { n: all.length })}
            </span>
          )}
        </span>
        <button type="button" className="th-new" onClick={() => setSheet(true)}>
          <PlusIcon />
          {t("newTerminalShort")}
        </button>
      </header>
      {tabs !== null && all.length === 0 && <div className="empty">{t("noTabs")}</div>}
      {groups.map((g) => (
        <section className="tr-group" key={g.key}>
          <div className="tr-ghead">
            <b>{g.title}</b>
            <span>{g.tabs.length === 1 ? t("tabCountOne") : t("tabCount", { n: g.tabs.length })}</span>
          </div>
          <div className="card tr-list">
            {g.tabs.map((x) => (
              <TermRow key={x.ptyId} tab={x} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
      <NewTerminalSheet
        open={sheet}
        folders={folders}
        onClose={() => setSheet(false)}
        onCreate={onCreate}
      />
    </>
  );
}
