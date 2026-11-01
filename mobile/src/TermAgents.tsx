import { useEffect } from "react";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { AgentInsight } from "./AgentInsight";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { CloseIcon } from "./icons";

/** The agent drawer of the phone's terminal and chat pages: the desktop's agent panel (context, usage, tools) for the agent shown (`activePty` or `chatId`), sliding in from the right. */
export function TermAgents({ activePty, chatId, open, onClose }: { activePty: string; chatId?: string; open: boolean; onClose: () => void }) {
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
    <AdaptiveSheet open={open} onClose={onClose} variant="drawer" side="right" phoneDrawer label={t("agentPanel")}>
      <header className="tm-sheet-head">
        <h2>{t("agentPanel")}</h2>
        <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <AgentInsight ptyId={chatId ? undefined : activePty} chatId={chatId} open={open} />
    </AdaptiveSheet>
  );
}
