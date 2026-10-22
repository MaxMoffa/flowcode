import type { ReactNode } from "react";
import { matchesQuery } from "../../shared/menuFilter";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { KeyboardIcon, MonitorIcon, PinIcon, PlusIcon, SlidersIcon, StopIcon } from "./icons";
import { MenuSearch, useMenuSearch } from "./MenuSearch";

interface Row {
  label: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** The row's current value, on its right. */
  value?: string;
  /** A rule after this row (when nothing is being searched). */
  sepAfter?: boolean;
}

/** The wide header's "Altre opzioni" dropdown, anchored under its button (the parent is positioned). */
export function WideMenu(props: {
  open: boolean;
  keys: boolean;
  /** No terminal is shown: the terminal-only rows are disabled. */
  noTerminal: boolean;
  /** The side panels are fixed (docked at any wide width). */
  pinned: boolean;
  onClose: () => void;
  onNewTerminal: () => void;
  onKeys: () => void;
  onPanels: () => void;
  onInterrupt: () => void;
  onComputers: () => void;
  onSettings: () => void;
}) {
  const { open, onClose } = props;
  useBackHandler(open, onClose);
  const search = useMenuSearch(open, onClose, true);
  if (!open) return null;

  const rows: Row[] = [
    { label: t("newTerminal"), icon: <PlusIcon />, run: props.onNewTerminal },
    { label: t("keyBar"), icon: <KeyboardIcon size={18} />, run: props.onKeys, disabled: props.noTerminal, value: props.keys ? t("keyBarOn") : t("keyBarOff") },
    { label: t("interruptCtrlC"), icon: <StopIcon />, run: props.onInterrupt, disabled: props.noTerminal, danger: true, sepAfter: true },
    { label: props.pinned ? t("floatPanels") : t("pinPanels"), icon: <PinIcon />, run: props.onPanels },
    { label: t("switchComputer"), icon: <MonitorIcon />, run: props.onComputers },
    { label: t("navSettings"), icon: <SlidersIcon />, run: props.onSettings },
  ];
  const searching = search.query.trim() !== "";
  const shown = rows.filter((r) => matchesQuery(r.label, search.query));

  return (
    <>
      <div className="w-menu-scrim" onClick={onClose} />
      <div className="w-menu" role="menu" aria-label={t("moreOptions")} {...search.menuProps}>
        <MenuSearch search={search} />
        {shown.length === 0 && <div className="menu-empty">{t("noResults")}</div>}
        {shown.map((r) => (
          <div key={r.label} className="w-menu-entry">
            <button type="button" role="menuitem" data-menu-row className={r.danger ? "danger" : undefined} disabled={r.disabled} onClick={r.run}>
              {r.icon}
              {r.label}
              {r.value && <span className="w-menu-k">{r.value}</span>}
            </button>
            {r.sepAfter && !searching && <i className="w-menu-sep" />}
          </div>
        ))}
      </div>
    </>
  );
}
