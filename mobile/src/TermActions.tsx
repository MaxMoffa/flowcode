import { needsSearch, sectionMenu } from "../../shared/menuFilter";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { ActionIcon, CloseIcon } from "./icons";
import { MenuSearch, useMenuSearch } from "./MenuSearch";
import { send, showToast, type Action, type Tab } from "./remote";
import { useWide } from "./wide";

/** Runs a quick action in a terminal. */
export function runAction(ptyId: string, a: Action) {
  send({ t: "action", id: a.id, ptyId });
  showToast(t("done"));
}

/** The desktop's quick actions, run in this terminal: a library with the agent launchers under "Agents", the rest under "Tools". A bottom sheet on the phone, a side drawer on the tablet layout (where the search field takes focus). */
export function TermActions({ tab, actions, open, onClose }: { tab: Tab; actions: Action[]; open: boolean; onClose: () => void }) {
  const search = useMenuSearch(open, onClose, useWide());
  const sections = sectionMenu(actions, search.query, (a) => a.label, (a) => !!a.cli);

  useBackHandler(open, onClose);

  function run(a: Action) {
    runAction(tab.ptyId, a);
    onClose();
  }

  return (
    <AdaptiveSheet open={open} onClose={onClose} variant="drawer" side="right" label={t("features")} panelProps={search.menuProps}>
      <div className="tm-grabber" />
      <header className="tm-sheet-head">
        <div className="tm-sheet-titles">
          <h2>{t("features")}</h2>
          <p>{t("runsIn", { label: tab.label })}</p>
        </div>
        <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {actions.length === 0 ? (
        <div className="tm-empty">{t("noActions")}</div>
      ) : (
        <>
          {needsSearch(actions.length) && <MenuSearch search={search} />}
          <div className="tm-sections">
            {sections.length === 0 && <div className="tm-empty">{t("noResults")}</div>}
            {sections.map((section) => (
              <section key={section.id} className="tm-section">
                <h3 className="tm-section-head">{section.id === "agents" ? t("sectionAgents") : t("sectionTools")}</h3>
                <div className="tm-tiles">
                  {section.items.map((a) => (
                    <button key={a.id} type="button" data-menu-row className="tm-tile" onClick={() => run(a)}>
                      <span className="tm-tile-icon">
                        <ActionIcon action={a} />
                      </span>
                      <span className="tm-tile-label">{a.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </AdaptiveSheet>
  );
}
