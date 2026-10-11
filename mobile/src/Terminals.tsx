import { StatusPill, shortCwd } from "./common";
import { t } from "./i18n";
import { ChevronIcon } from "./icons";
import type { Tab } from "./remote";

export function TerminalsScreen({ tabs, onOpen }: { tabs: Tab[] | null; onOpen: (ptyId: string) => void }) {
  const windows = [...new Set((tabs ?? []).map((x) => x.window))];
  return (
    <>
      <header className="top">
        <h1>{t("terminals")}</h1>
      </header>
      {tabs !== null && tabs.length === 0 && <div className="empty">{t("noTabs")}</div>}
      {windows.map((w) => (
        <section key={w}>
          <h2 className="group">{w || t("window")}</h2>
          <div className="stack">
            {(tabs ?? [])
              .filter((x) => x.window === w)
              .map((x) => (
                <button key={x.ptyId} type="button" className="card row" onClick={() => onOpen(x.ptyId)}>
                  <span className="row-body">
                    <span className="row-title">{x.label}</span>
                    <span className="row-sub mono">{shortCwd(x.cwd)}</span>
                  </span>
                  {x.cli && <StatusPill status={x.status} />}
                  <ChevronIcon />
                </button>
              ))}
          </div>
        </section>
      ))}
    </>
  );
}
