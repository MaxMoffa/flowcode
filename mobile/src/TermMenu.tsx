import type { ReactNode } from "react";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import { BoltIcon, CloseIcon, FolderIcon, KeyboardIcon } from "./icons";

interface Row {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
}

/** The "⋯" popover: files, quick actions, keyboard toggle, interrupt, and closing the tab when `onCloseTab` is given. */
export function TermMenu(props: {
  open: boolean;
  kbOpen: boolean;
  onClose: () => void;
  onFiles: () => void;
  onActions: () => void;
  onKeyboard: () => void;
  onInterrupt: () => void;
  onCloseTab?: () => void;
}) {
  const { open, onClose } = props;
  useBackHandler(open, onClose);
  useEscape(open, onClose);
  if (!open) return null;

  const rows: Row[] = [
    { label: t("termMenuFiles"), icon: <FolderIcon />, run: props.onFiles },
    { label: t("termMenuActions"), icon: <BoltIcon />, run: props.onActions },
    { label: props.kbOpen ? t("hideKeyboard") : t("showKeyboard"), icon: <KeyboardIcon size={18} />, run: props.onKeyboard },
    { label: t("termMenuInterrupt"), icon: <span className="tm-menu-c">^C</span>, run: props.onInterrupt, danger: true },
  ];
  if (props.onCloseTab) rows.push({ label: t("closeTerminal"), icon: <CloseIcon />, run: props.onCloseTab, danger: true });

  return (
    <>
      <div className="tm-menu-scrim" onClick={onClose} />
      <div className="tm-menu" role="menu">
        {rows.map((r) => (
          <button key={r.label} type="button" role="menuitem" className={r.danger ? "danger" : undefined} onClick={r.run}>
            {r.icon}
            {r.label}
          </button>
        ))}
      </div>
    </>
  );
}
