import { useRef } from "react";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import { ActionIcon, CloseIcon } from "./icons";
import { send, showToast, type Action, type Tab } from "./remote";
import { useSheetDrag } from "./useSheetDrag";

/** Runs a quick action in a terminal. */
export function runAction(ptyId: string, a: Action) {
  send({ t: "action", id: a.id, ptyId });
  showToast(t("done"));
}

/** Bottom sheet with the desktop's quick actions, run in this terminal. */
export function TermActions({ tab, actions, open, onClose }: { tab: Tab; actions: Action[]; open: boolean; onClose: () => void }) {
  useEscape(open, onClose);

  useBackHandler(open, onClose);
  const sheet = useRef<HTMLElement>(null);
  useSheetDrag(sheet, onClose, open);

  function run(a: Action) {
    runAction(tab.ptyId, a);
    onClose();
  }

  return (
    <div className={"tm-layer" + (open ? " open" : "")}>
      <div className="tm-scrim" onClick={onClose} />
      <section ref={sheet} className="tm-sheet" role="dialog" aria-modal="true" aria-label={t("features")} aria-hidden={!open}>
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
        {actions.length === 0 && <div className="tm-empty">{t("noActions")}</div>}
        <div className="tm-tiles">
          {actions.map((a) => (
            <button key={a.id} type="button" className="tm-tile" onClick={() => run(a)}>
              <span className="tm-tile-icon">
                <ActionIcon action={a} />
              </span>
              <span className="tm-tile-label">{a.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
