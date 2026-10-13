import { useEffect } from "react";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { BoltIcon } from "./icons";
import { send, showToast, type Action, type Tab } from "./remote";
import { CloseIcon } from "./termIcons";

/** Bottom sheet with the desktop's quick actions, run in this terminal. */
export function TermActions({ tab, actions, open, onClose }: { tab: Tab; actions: Action[]; open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useBackHandler(open, onClose);

  function run(a: Action) {
    send({ t: "action", id: a.id, ptyId: tab.ptyId });
    showToast(t("done"));
    onClose();
  }

  return (
    <div className={"tm-layer" + (open ? " open" : "")}>
      <div className="tm-scrim" onClick={onClose} />
      <section className="tm-sheet" role="dialog" aria-modal="true" aria-label={t("features")} aria-hidden={!open}>
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
                <BoltIcon />
              </span>
              <span className="tm-tile-label">{a.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
