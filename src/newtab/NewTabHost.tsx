import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { NewTabCustomize } from "./NewTabCustomize";
import { PencilIcon } from "./icons";
import { resolveNewTabLayout, useNewTabLayouts } from "./layouts";
import { useNewTabSettings } from "./newTabSettings";
import type { NewTabHostProps } from "./types";
import "./builtins";
import "./newtab-customize.css";

/** What a new tab shows: the layout the user picked (see layouts.ts), and over
 * it - on every layout, a plugin's included - the "Personalizza" button and its
 * panel. */
export function NewTabHost(props: NewTabHostProps) {
  const { t } = useI18n();
  const [{ layout: layoutId }] = useNewTabSettings();
  // Re-resolves when a plugin layout is installed or removed.
  useNewTabLayouts();
  const { component: Layout, ownCustomizeButton } = resolveNewTabLayout(layoutId);
  const [customizing, setCustomizing] = useState(false);
  /** The page is handing the tab over to a terminal: nothing of the host stays on it. */
  const [launched, setLaunched] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function close() {
    setCustomizing(false);
    buttonRef.current?.focus();
  }

  return (
    <>
      <Layout
        {...props}
        onLaunch={(launch) => {
          setLaunched(true);
          setCustomizing(false);
          props.onLaunch(launch);
        }}
        onCustomize={() => setCustomizing(true)}
        customizing={customizing}
      />
      {!props.hidden && !launched && (
        <>
          {!ownCustomizeButton && (
            <button
              ref={buttonRef}
              type="button"
              className="newtab-customize-button"
              title={t("newTab.customize")}
              aria-label={t("newTab.customize")}
              onClick={() => setCustomizing(true)}
            >
              <PencilIcon size={15} />
            </button>
          )}
          {customizing && <NewTabCustomize onClose={close} />}
        </>
      )}
    </>
  );
}
