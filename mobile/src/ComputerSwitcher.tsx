import { useCallback, useEffect, useState } from "react";
import { useBackHandler } from "./back";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { Svg } from "./icons";
import { listComputers, showToast, switchComputer, type Computer } from "./remote";

/** "Flowcode · <host>" in the Agents header: the paired computers to switch between, and "add one". */
export function ComputerSwitcher({ hostName, onAdd }: { hostName?: string; onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Computer[] | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useBackHandler(open, close);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listComputers().then((l) => live && setList(l));
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

  return (
    <div className="cs">
      <button type="button" className="cs-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Flowcode <span>· {hostName ?? "..."}</span>
        <Svg size={16}>
          <path d="m6 9 6 6 6-6" />
        </Svg>
      </button>
      {open && (
        <>
          <div className="cs-scrim" onClick={close} />
          <div className="cs-menu" role="menu" aria-label={t("computers")}>
            {list === null ? (
              <div className="cs-empty">...</div>
            ) : (
              list.map((c) => (
                <button key={c.id} type="button" role="menuitemradio" aria-checked={c.active} className={c.active ? "on" : ""} onClick={() => pick(c)}>
                  <span className="cs-name">{c.hostName}</span>
                  {c.active && (
                    <Svg size={18} strokeWidth={2.4}>
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </Svg>
                  )}
                </button>
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
