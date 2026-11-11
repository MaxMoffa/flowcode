import type { ReactNode } from "react";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import type { UiScale } from "./uiScale";
import { CheckIcon, GlobeIcon, KeyboardIcon, MonitorIcon, PinIcon, PlusIcon, SlidersIcon, StopIcon } from "./icons";

interface Row {
  label: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** The row's current value, on its right. */
  value?: string;
  /** A rule after this row. */
  sepAfter?: boolean;
}

const SCALES: UiScale[] = ["compact", "normal", "large"];
const SCALE_LABEL = { compact: "uiSizeCompact", normal: "uiSizeNormal", large: "uiSizeLarge" } as const;

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
  /** Opens the in-app browser; omitted when the desktop lacks it. */
  onBrowser?: () => void;
  onComputers: () => void;
  onSettings: () => void;
  /** The wide chrome's UI size. */
  scale: UiScale;
  onScale: (scale: UiScale) => void;
  /** The theme this phone shows. */
  theme: "auto" | "light" | "dark";
  onTheme: (theme: "auto" | "light" | "dark") => void;
}) {
  const { open, onClose } = props;
  useBackHandler(open, onClose);
  useEscape(open, onClose);
  if (!open) return null;

  const scaleAt = SCALES.indexOf(props.scale);
  const themes = [
    { id: "auto", label: t("themeAuto") },
    { id: "light", label: t("themeLight") },
    { id: "dark", label: t("themeDark") },
  ] as const;

  const rows: Row[] = [
    { label: t("newTerminal"), icon: <PlusIcon />, run: props.onNewTerminal },
    { label: t("keyBar"), icon: <KeyboardIcon size={18} />, run: props.onKeys, disabled: props.noTerminal, value: props.keys ? t("keyBarOn") : t("keyBarOff") },
    { label: t("interruptCtrlC"), icon: <StopIcon />, run: props.onInterrupt, disabled: props.noTerminal, danger: true, sepAfter: true },
    ...(props.onBrowser ? [{ label: t("browser.menu"), icon: <GlobeIcon />, run: props.onBrowser }] : []),
    { label: props.pinned ? t("floatPanels") : t("pinPanels"), icon: <PinIcon />, run: props.onPanels },
    { label: t("switchComputer"), icon: <MonitorIcon />, run: props.onComputers },
    { label: t("navSettings"), icon: <SlidersIcon />, run: props.onSettings, sepAfter: true },
  ];
  const themeRows: Row[] = themes.map((x) => ({ label: x.label, icon: props.theme === x.id ? <CheckIcon /> : <i className="w-menu-nocheck" />, run: () => props.onTheme(x.id) }));

  return (
    <>
      <div className="w-menu-scrim" onClick={onClose} />
      <div className="w-menu" role="menu" aria-label={t("moreOptions")}>
        <div className="w-menu-zoom">
          <span>{t("zoom")}</span>
          <button type="button" aria-label="-" disabled={scaleAt <= 0} onClick={() => props.onScale(SCALES[scaleAt - 1])}>
            -
          </button>
          <b>{t(SCALE_LABEL[props.scale])}</b>
          <button type="button" aria-label="+" disabled={scaleAt >= SCALES.length - 1} onClick={() => props.onScale(SCALES[scaleAt + 1])}>
            +
          </button>
        </div>
        <i className="w-menu-sep" />
        {[...rows, ...themeRows].map((r, i) => (
          <div key={r.label + i} className="w-menu-entry">
            {i === rows.length && <span className="w-menu-label">{t("theme")}</span>}
            <button type="button" role={i >= rows.length ? "menuitemradio" : "menuitem"} aria-checked={i >= rows.length ? props.theme === themes[i - rows.length].id : undefined} className={r.danger ? "danger" : undefined} disabled={r.disabled} onClick={r.run}>
              {r.icon}
              {r.label}
              {r.value && <span className="w-menu-k">{r.value}</span>}
            </button>
            {r.sepAfter && <i className="w-menu-sep" />}
          </div>
        ))}
      </div>
    </>
  );
}
