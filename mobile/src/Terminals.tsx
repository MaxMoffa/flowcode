import { StatusPill, shortCwd } from "./common";
import { t } from "./i18n";
import { ChevronIcon, TerminalIcon } from "./icons";
import type { Tab } from "./remote";

/** Initial letter in the agent's badge; Codex reads better as "X". */
function badge(cli: string): { letter: string; kind: string } {
  const c = cli.toLowerCase();
  if (c.includes("codex")) return { letter: "X", kind: "codex" };
  if (c.includes("claude")) return { letter: "C", kind: "claude" };
  return { letter: (cli[0] ?? "?").toUpperCase(), kind: "other" };
}

function AgentCard({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  const b = badge(tab.cli ?? "");
  return (
    <button type="button" className={"card tcard" + (tab.status === "waiting" ? " is-waiting" : "")} onClick={() => onOpen(tab.ptyId)}>
      <span className="tcard-head">
        <span className={"tbadge " + b.kind}>{b.letter}</span>
        <span className="row-body">
          <b className="tcard-title">{tab.label}</b>
          <span className="row-sub mono">{shortCwd(tab.cwd)}</span>
        </span>
        <StatusPill status={tab.status} />
      </span>
    </button>
  );
}

export function TerminalsScreen({ hostName, tabs, onOpen }: { hostName?: string; tabs: Tab[] | null; onOpen: (ptyId: string) => void }) {
  const all = tabs ?? [];
  const agents = all.filter((x) => x.cli);
  const shells = all.filter((x) => !x.cli);
  return (
    <>
      <header className="th">
        <h1>{t("terminals")}</h1>
        {tabs !== null && (
          <span className="th-sub">
            {hostName ? `${hostName} · ` : ""}
            {all.length === 1 ? t("openCountOne") : t("openCount", { n: all.length })}
          </span>
        )}
      </header>
      {tabs !== null && all.length === 0 && <div className="empty">{t("noTabs")}</div>}
      {agents.length > 0 && (
        <section className="tsection">
          <h2 className="gh">{t("withAgent")}</h2>
          {agents.map((x) => (
            <AgentCard key={x.ptyId} tab={x} onOpen={onOpen} />
          ))}
        </section>
      )}
      {shells.length > 0 && (
        <section className="tsection">
          <h2 className="gh">{t("shellsGroup")}</h2>
          <div className="card tlist">
            {shells.map((x) => (
              <button key={x.ptyId} type="button" className="trow" onClick={() => onOpen(x.ptyId)}>
                <span className="tbadge plain">
                  <TerminalIcon />
                </span>
                <span className="row-body">
                  <b className="trow-title">{x.label}</b>
                  <span className="row-sub mono">{shortCwd(x.cwd)}</span>
                </span>
                <ChevronIcon />
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
