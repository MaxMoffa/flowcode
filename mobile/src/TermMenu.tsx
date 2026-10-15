import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import { BoltIcon, FolderIcon, KeyboardIcon } from "./icons";

/** The "⋯" popover: files, quick actions, keyboard toggle, interrupt. */
export function TermMenu(props: {
  open: boolean;
  kbOpen: boolean;
  onClose: () => void;
  onFiles: () => void;
  onActions: () => void;
  onKeyboard: () => void;
  onInterrupt: () => void;
}) {
  const { open, onClose } = props;
  useBackHandler(open, onClose);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="tm-menu-scrim" onClick={onClose} />
      <div className="tm-menu" role="menu">
        <button type="button" role="menuitem" onClick={props.onFiles}>
          <FolderIcon />
          {t("termMenuFiles")}
        </button>
        <button type="button" role="menuitem" onClick={props.onActions}>
          <BoltIcon />
          {t("termMenuActions")}
        </button>
        <button type="button" role="menuitem" onClick={props.onKeyboard}>
          <KeyboardIcon size={18} />
          {props.kbOpen ? t("hideKeyboard") : t("showKeyboard")}
        </button>
        <button type="button" role="menuitem" className="danger" onClick={props.onInterrupt}>
          <span className="tm-menu-c">^C</span>
          {t("termMenuInterrupt")}
        </button>
      </div>
    </>
  );
}
