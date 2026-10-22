import { useEffect } from "react";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { AgentsScreen } from "./Agents";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { CloseIcon } from "./icons";
import { useRemoteSelector } from "./remote";

/** The agents drawer of the phone's terminal page: the desktop's agents sidebar (agents, then usage), sliding in from the right. */
export function TermAgents({ activePty, open, onClose, onOpen }: { activePty: string; open: boolean; onClose: () => void; onOpen: (ptyId: string) => void }) {
  const tabs = useRemoteSelector((s) => s.tabs);
  useBackHandler(open, onClose);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AdaptiveSheet open={open} onClose={onClose} variant="drawer" side="right" phoneDrawer label={t("activeAgents")}>
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
    </AdaptiveSheet>
  );
}
