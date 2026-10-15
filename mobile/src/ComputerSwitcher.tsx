import { useCallback, useEffect, useState } from "react";
import { useBackHandler } from "./back";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { ChevronDownIcon, MonitorIcon, Svg } from "./icons";
import { forgetComputer, listComputers, showToast, switchComputer, useRemoteSelector, type Computer } from "./remote";

/**
 * "Flowcode · <host>" in the Agents header: the paired computers to switch between, and "add one".
 * `pill`: the wide layout's bordered chip (connection dot, host, chevron); `open` / `onOpenChange` let the layout open the menu from elsewhere.
 */
export function ComputerSwitcher({ hostName, onAdd, pill, open: openProp, onOpenChange }: { hostName?: string; onAdd: () => void; pill?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const status = useRemoteSelector((s) => s.status);
  const [list, setList] = useState<Computer[] | null>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useBackHandler(open, close);
  useEffect(() => {
    if (!open) return;
    let live = true;
    listComputers()
      .then((l) => live && setList(l))
      .catch((e) => {
        if (!live) return;
        setList([]);
        showToast(typeof e === "string" ? e : t("computersFailed"));
      });
    return () => {
      live = false;
    };
  }, [open]);

  function pick(c: Computer) {
    setOpen(false);
    if (c.active) return;
    tapFeedback();
    switchComputer(c.id).catch((e) => showToast(typeof e === "string" ? e : t("switchFailed")));
  }

  function forget(c: Computer) {
    if (!window.confirm(t("forgetComputerConfirm", { host: c.hostName }))) return;
    forgetComputer(c.id)
      .then(() => listComputers())
      .then(setList)
      .catch((e) => showToast(typeof e === "string" ? e : t("forgetComputerFailed")));
  }

  return (
    <div className={"cs" + (pill ? " is-pill" : "")}>
      {pill ? (
        <button type="button" className="cs-pill" aria-label={t("computers")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <i className={"dot" + (status === "online" ? " on" : status === "offline" ? "" : " wait")} />
          <MonitorIcon />
          <span className="cs-host">{hostName ?? "..."}</span>
          <ChevronDownIcon />
        </button>
      ) : (
        <button type="button" className="cs-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Flowcode <span>· {hostName ?? "..."}</span>
          <Svg size={16}>
            <path d="m6 9 6 6 6-6" />
          </Svg>
        </button>
      )}
      {open && (
        <>
          <div className="cs-scrim" onClick={close} />
          <div className="cs-menu" role="menu" aria-label={t("computers")}>
            {list === null ? (
              <div className="cs-empty">...</div>
            ) : (
              list.map((c) => (
                <div key={c.id} className="cs-row">
                  <button type="button" role="menuitemradio" aria-checked={c.active} className={c.active ? "on" : ""} onClick={() => pick(c)}>
                    <span className="cs-name">{c.hostName}</span>
                    {c.active && (
                      <Svg size={18} strokeWidth={2.4}>
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </Svg>
                    )}
                  </button>
                  {!c.active && (
                    <button type="button" className="cs-forget" aria-label={t("forgetComputer")} onClick={() => forget(c)}>
                      <Svg size={16}>
                        <path d="M6 6l12 12M18 6 6 18" />
                      </Svg>
                    </button>
                  )}
                </div>
              ))
            )}
            <button
              type="button"
              role="menuitem"
              className="cs-add"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              <Svg size={18}>
                <path d="M12 5v14M5 12h14" />
              </Svg>
              {t("addComputer")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
