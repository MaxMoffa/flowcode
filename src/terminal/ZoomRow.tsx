import { useEffect, useRef, useState } from "react";
import { Icons } from "../app/icons";
import { useI18n } from "../i18n";
import { useTerminalSettings } from "./TerminalSettingsContext";

/** The context menu's zoom row, as its own component rather than inline JSX
 * built from App's own state - the menu's items are a snapshot captured
 * once when it opens (see ContextMenuProvider), so a plain `{size}px` baked
 * into that snapshot would never update after +/- clicks while the menu
 * stays open. Subscribing to `useTerminalSettings()` here instead means this
 * component re-renders off the context itself, independent of when its
 * enclosing JSX was created.
 *
 * +/- here zoom only `tabId` (the last-active terminal), like a browser's
 * per-tab zoom - the app-wide default (Settings > terminale) is untouched.
 * When this tab's size has drifted from that default, the value switches to
 * the accent color and a reset button appears next to it. The px box itself
 * is a real input - typing a value and committing it (Enter/blur) goes
 * through the same `setTabFontSize` the +/- buttons use. */
export function ZoomRow({ tabId }: { tabId: string }) {
  const {
    fontSize: defaultSize,
    tabFontSizeOverrides,
    getTabFontSize,
    zoomTabIn,
    zoomTabOut,
    setTabFontSize,
    resetTabZoom,
  } = useTerminalSettings();
  const { t } = useI18n();
  const size = getTabFontSize(tabId);
  const isCustom = tabId in tabFontSizeOverrides;
  // A locally-staged copy of the digits being typed - committing on every
  // keystroke would run each partial value through `setTabFontSize`'s
  // clamp (e.g. "1" while typing "12" would clamp up to MIN_SIZE and never
  // let the second digit land). Only applied on blur/Enter; reverts to the
  // real size on Escape or on unparsable input.
  const [draft, setDraft] = useState(String(size));
  useEffect(() => setDraft(String(size)), [size]);
  // Escape blurs the input, and that blur must not commit the stale draft.
  const cancelRef = useRef(false);

  function commit() {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    const parsed = parseInt(draft, 10);
    if (Number.isFinite(parsed)) setTabFontSize(tabId, parsed);
    else setDraft(String(size));
  }

  return (
    <div className="context-menu-zoom-row">
      <button type="button" className="context-menu-zoom-btn" aria-label={t("zoom.out")} onClick={() => zoomTabOut(tabId)}>
        −
      </button>
      <button type="button" className="context-menu-zoom-btn" aria-label={t("zoom.in")} onClick={() => zoomTabIn(tabId)}>
        +
      </button>
      <span
        className={"context-menu-zoom-value" + (isCustom ? " is-custom" : "")}
        title={isCustom ? t("zoom.custom", { size: defaultSize }) : t("zoom.thisTerminal")}
      >
        <input
          type="text"
          inputMode="numeric"
          className="context-menu-zoom-input"
          value={draft}
          aria-label={t("zoom.fontSize")}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(String(size));
              cancelRef.current = true;
              e.currentTarget.blur();
            }
          }}
        />
        <span className="context-menu-zoom-unit">px</span>
      </span>
      <button
        type="button"
        className="context-menu-zoom-btn context-menu-zoom-reset"
        aria-label={t("zoom.reset")}
        title={t("zoom.reset")}
        disabled={!isCustom}
        onClick={() => resetTabZoom(tabId)}
      >
        {Icons.zoomReset}
      </button>
    </div>
  );
}
