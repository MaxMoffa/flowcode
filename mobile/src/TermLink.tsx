import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { CheckIcon, CloseIcon, CopyIcon, GlobeIcon } from "./icons";
import { setSetting, showToast } from "./remote";
import { useSheetDrag } from "./useSheetDrag";

/** Opens a web link in the phone's browser; outside Tauri (browser dev) a new tab does it. */
export async function openLink(url: string) {
  try {
    if ("__TAURI_INTERNALS__" in window) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch {
    showToast(t("linkOpenFailed"));
  }
}

/** Bottom sheet for a link tapped in the terminal; open while `url` is set. */
export function TermLink({ url, onClose }: { url: string | null; onClose: () => void }) {
  const open = url !== null;
  // Keep the text while the sheet slides out.
  const last = useRef("");
  if (url) last.current = url;
  const shown = last.current;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useBackHandler(open, onClose);
  const sheet = useRef<HTMLElement>(null);
  useSheetDrag(sheet, onClose, open);

  function openIt(always: boolean) {
    if (always) setSetting("confirmLinkOpen", false);
    void openLink(shown);
    onClose();
  }

  function copy() {
    navigator.clipboard.writeText(shown).then(
      () => showToast(t("linkCopied")),
      () => showToast(t("linkOpenFailed")),
    );
    onClose();
  }

  return (
    <div className={"tm-layer" + (open ? " open" : "")}>
      <div className="tm-scrim" onClick={onClose} />
      <section ref={sheet} className="tm-sheet" role="dialog" aria-modal="true" aria-label={t("linkTitle")} aria-hidden={!open}>
        <div className="tm-grabber" />
        <header className="tm-sheet-head">
          <div className="tm-sheet-titles">
            <h2>{t("linkTitle")}</h2>
            <p className="tm-link-url">{shown}</p>
          </div>
          <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="tm-link-rows">
          <button type="button" className="tm-link-row" onClick={() => openIt(false)}>
            <GlobeIcon />
            <span>{t("linkOpen")}</span>
          </button>
          <button type="button" className="tm-link-row" onClick={() => openIt(true)}>
            <CheckIcon />
            <span>{t("linkOpenAlways")}</span>
          </button>
          <button type="button" className="tm-link-row" onClick={copy}>
            <CopyIcon />
            <span>{t("linkCopy")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
