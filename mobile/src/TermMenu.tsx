import type { ReactNode } from "react";
import { matchesQuery, needsSearch } from "../../shared/menuFilter";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { BoltIcon, CloseIcon, FolderIcon, KeyboardIcon } from "./icons";
import { MenuSearch, useMenuSearch } from "./MenuSearch";

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
  const search = useMenuSearch(open, onClose, false);
  if (!open) return null;

  const rows: Row[] = [
    { label: t("termMenuFiles"), icon: <FolderIcon />, run: props.onFiles },
    { label: t("termMenuActions"), icon: <BoltIcon />, run: props.onActions },
    { label: props.kbOpen ? t("hideKeyboard") : t("showKeyboard"), icon: <KeyboardIcon size={18} />, run: props.onKeyboard },
    { label: t("termMenuInterrupt"), icon: <span className="tm-menu-c">^C</span>, run: props.onInterrupt, danger: true },
  ];
  if (props.onCloseTab) rows.push({ label: t("closeTerminal"), icon: <CloseIcon />, run: props.onCloseTab, danger: true });
  // Four rows are quicker to read than to search.
  const searchable = needsSearch(rows.length);
  const shown = rows.filter((r) => matchesQuery(r.label, search.query));

  return (
    <>
      <div className="tm-menu-scrim" onClick={onClose} />
      <div className="tm-menu" role="menu" {...search.menuProps}>
        {searchable && <MenuSearch search={search} />}
        {shown.length === 0 && <div className="menu-empty">{t("noResults")}</div>}
        {shown.map((r) => (
          <button key={r.label} type="button" role="menuitem" data-menu-row className={r.danger ? "danger" : undefined} onClick={r.run}>
            {r.icon}
            {r.label}
          </button>
        ))}
      </div>
    </>
  );
}
