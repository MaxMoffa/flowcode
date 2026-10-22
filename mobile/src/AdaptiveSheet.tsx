import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type MutableRefObject, type ReactNode, type Ref } from "react";
import { dragEdge, wrapFocusIndex, type SheetSide, type SheetVariant } from "./sheetLayout";
import "./adaptive.css";
import { useUiZoom } from "./uiScale";
import { useSheetDrag } from "./useSheetDrag";
import { useWide } from "./wide";

/** The phone CSS a sheet keeps on narrow screens: the session/actions sheets (tm), "Nuovo terminale" and the update sheet (nts), the profile sheets (ps), "connection lost" (rc). */
type SheetFamily = "tm" | "nts" | "ps" | "rc";

const FAMILY: Record<SheetFamily, { layer: string; scrim: string; panel: string; drawer: string; openClass: boolean }> = {
  tm: { layer: "tm-layer", scrim: "tm-scrim", panel: "tm-sheet", drawer: "tm-drawer", openClass: true },
  nts: { layer: "nts-layer", scrim: "nts-scrim", panel: "nts", drawer: "nts", openClass: false },
  ps: { layer: "ps-layer", scrim: "ps-scrim", panel: "ps-sheet", drawer: "ps-sheet", openClass: true },
  rc: { layer: "rc-layer", scrim: "rc-scrim", panel: "rc-sheet", drawer: "rc-sheet", openClass: false },
};

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
const visible = (el: HTMLElement) => el.getClientRects().length > 0;

export interface AdaptiveSheetProps {
  open: boolean;
  onClose: () => void;
  /** On the tablet layout: a centered dialog (forms, confirmations) or a side drawer (lists, menus, inspectors). */
  variant: SheetVariant;
  /** The drawer's edge on the tablet layout (and on the phone, with `phoneDrawer`). */
  side?: SheetSide;
  family?: SheetFamily;
  /** The sheet is already a side drawer on the phone (the file explorer, the agents list). */
  phoneDrawer?: boolean;
  label?: string;
  labelledBy?: string;
  /** False while something else (a file preview) owns the touch drag. */
  dragEnabled?: boolean;
  /** Render under <body> on the phone too (the page slides with a transform, which would pin a fixed layer to it). */
  portal?: boolean;
  /** Extra classes on the scrim / panel, for states the caller animates (a fading "connection lost"). */
  scrimClass?: string;
  panelClass?: string;
  /** Handlers the panel carries (a menu's arrow-key navigation). */
  panelProps?: HTMLAttributes<HTMLElement>;
  panelRef?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * One container for every phone sheet. Narrow screens get the original bottom sheet (or side
 * drawer); on the tablet layout it becomes a desktop surface instead: a centered dialog or a
 * side drawer under the header, above any docked panel, with a scrim, a focus trap and focus
 * restored on close. Escape and Back stay with the caller (`useEscape`, `useBackHandler`); a
 * drawer also closes by dragging it toward its edge.
 */
export function AdaptiveSheet({ open, onClose, variant, side = "right", family = "tm", phoneDrawer = false, label, labelledBy, dragEnabled = true, portal = false, scrimClass, panelClass, panelProps, panelRef, children }: AdaptiveSheetProps) {
  const wide = useWide();
  const zoom = useUiZoom();
  const fam = FAMILY[family];
  const [el, setEl] = useState<HTMLElement | null>(null);
  const setRef = useCallback(
    (n: HTMLElement | null) => {
      setEl(n);
      if (typeof panelRef === "function") panelRef(n);
      else if (panelRef) (panelRef as MutableRefObject<HTMLElement | null>).current = n;
    },
    [panelRef],
  );
  const ref = useMemo(() => ({ current: el }), [el]);

  const edge = dragEdge(wide, variant, side, phoneDrawer);
  useSheetDrag(ref, onClose, dragEnabled && open && edge !== null, edge ?? "down");

  // A sheet mounted already open (the new-terminal dialog) needs one closed frame to animate in from.
  const [armed, setArmed] = useState(!open);
  useEffect(() => {
    if (!open || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [open, armed]);
  const shown = open && armed;

  // Tablet: focus moves into the sheet when it opens (a field the caller focused already wins) and back to where it came from when it closes.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!wide || !shown || !el) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[data-autofocus], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
      (first && visible(first) ? first : el).focus({ preventScroll: true });
    }
    return () => {
      const back = returnTo.current;
      const now = document.activeElement;
      if (back?.isConnected && (now === document.body || now === null || el.contains(now))) back.focus({ preventScroll: true });
    };
  }, [wide, shown, el]);

  function trap(e: KeyboardEvent) {
    if (e.key !== "Tab" || !el) return;
    const active = document.activeElement;
    // A menu portalled out of the panel (the new-terminal pickers) manages its own focus.
    if (active && active !== document.body && active !== el && !el.contains(active)) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
    const next = items[wrapFocusIndex(active ? items.indexOf(active as HTMLElement) : -1, items.length, e.shiftKey)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  const asDrawer = wide ? variant === "drawer" : phoneDrawer;
  const Panel = (asDrawer ? "aside" : family === "tm" || family === "ps" ? "section" : "div") as "section";
  const panel = (
    <Panel
      {...panelProps}
      ref={setRef}
      className={[asDrawer ? fam.drawer : fam.panel, wide ? "as-panel" : "", !wide && phoneDrawer && side === "right" ? "right" : "", panelClass].filter(Boolean).join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-hidden={!open}
      tabIndex={-1}
    >
      {children}
    </Panel>
  );

  const tree = wide ? (
    <div className={`as-layer as-${variant} as-${side}` + (shown ? " open" : "")} style={{ "--as-zoom": zoom } as CSSProperties} onKeyDown={trap}>
      <div className={["as-scrim", scrimClass].filter(Boolean).join(" ")} data-sheet-scrim onClick={onClose} />
      {panel}
    </div>
  ) : (
    <div className={fam.layer + (fam.openClass && open ? " open" : "")}>
      <div className={[fam.scrim, scrimClass].filter(Boolean).join(" ")} data-sheet-scrim onClick={onClose} />
      {panel}
    </div>
  );
  return wide || portal ? createPortal(tree, document.body) : tree;
}
