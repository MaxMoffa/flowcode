import { useEffect, useRef } from "react";
import { AgentsScreen } from "./Agents";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { CloseIcon } from "./icons";
import { useRemoteSelector } from "./remote";
import { useSheetDrag } from "./useSheetDrag";

/** The agents drawer of the phone's terminal page: the desktop's agents sidebar (agents, then usage), sliding in from the right. */
export function TermAgents({ activePty, open, onClose, onOpen }: { activePty: string; open: boolean; onClose: () => void; onOpen: (ptyId: string) => void }) {
  const tabs = useRemoteSelector((s) => s.tabs);
  useBackHandler(open, onClose);
  const drawer = useRef<HTMLElement>(null);
  useSheetDrag(drawer, onClose, open, "right");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={"tm-layer" + (open ? " open" : "")}>
      <div className="tm-scrim" onClick={onClose} />
      <aside ref={drawer} className="tm-drawer right" role="dialog" aria-modal="true" aria-label={t("activeAgents")} aria-hidden={!open}>
        <header className="tm-sheet-head">
          <h2>{t("activeAgents")}</h2>
          <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="tm-agents">
          <AgentsScreen
            compact
            tabs={tabs}
            activePty={activePty}
            onOpen={(id) => {
              onClose();
              if (id !== activePty) onOpen(id);
            }}
            onAddComputer={() => {}}
          />
        </div>
      </aside>
    </div>
  );
}
