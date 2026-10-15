import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import { KeyboardIcon, MonitorIcon, PlusIcon, SlidersIcon, StopIcon } from "./icons";

/** The wide header's "Altre opzioni" dropdown, anchored under its button (the parent is positioned). */
export function WideMenu(props: {
  open: boolean;
  keys: boolean;
  /** No terminal is shown: the terminal-only rows are disabled. */
  noTerminal: boolean;
  onClose: () => void;
  onNewTerminal: () => void;
  onKeys: () => void;
  onInterrupt: () => void;
  onComputers: () => void;
  onSettings: () => void;
}) {
  const { open, onClose } = props;
  useBackHandler(open, onClose);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="w-menu-scrim" onClick={onClose} />
      <div className="w-menu" role="menu" aria-label={t("moreOptions")}>
        <button type="button" role="menuitem" onClick={props.onNewTerminal}>
          <PlusIcon />
          {t("newTerminal")}
        </button>
        <button type="button" role="menuitem" disabled={props.noTerminal} onClick={props.onKeys}>
          <KeyboardIcon size={18} />
          {t("keyBar")}
          <span className="w-menu-k">{props.keys ? t("keyBarOn") : t("keyBarOff")}</span>
        </button>
        <button type="button" role="menuitem" className="danger" disabled={props.noTerminal} onClick={props.onInterrupt}>
          <StopIcon />
          {t("interruptCtrlC")}
        </button>
        <i className="w-menu-sep" />
        <button type="button" role="menuitem" onClick={props.onComputers}>
          <MonitorIcon />
          {t("switchComputer")}
        </button>
        <button type="button" role="menuitem" onClick={props.onSettings}>
          <SlidersIcon />
          {t("navSettings")}
        </button>
      </div>
    </>
  );
}
