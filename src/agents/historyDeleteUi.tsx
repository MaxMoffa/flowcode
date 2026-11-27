import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

/** A single delete can be undone for this long; another delete restarts the wait. */
export const UNDO_MS = 6000;
const ERROR_TOAST_MS = 4000;

export const MORE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="12.5" cy="8" r="1.4" />
  </svg>
);

/** The "⋯" at a row's right edge: a span, since a button can't sit inside the row's button. */
export function RowMore({ label, onOpen }: { label: string; onOpen: (rect: DOMRect) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={label}
      title={label}
      className="agent-history-more"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onOpen(e.currentTarget.getBoundingClientRect());
        }
      }}
    >
      {MORE_ICON}
    </span>
  );
}

export type HistoryToastState = { id: number; kind: "undo" | "error"; text: string };

/** Undo-able single deletes: `queue` hides the entries and commits them after `UNDO_MS` unless `undo` runs first.
 * `commit` does the real delete (it gets `reportFailed` for what could not be deleted). */
export function useUndoDelete<E extends { key: string }>(opts: {
  hide: (keys: string[]) => void;
  unhide: (keys: string[]) => void;
  commit: (entries: E[], reportFailed: (count: number) => void) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [toast, setToast] = useState<HistoryToastState | null>(null);
  const toastId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Chats deleted but not yet committed: Undo takes them back until the timer runs out. */
  const batch = useRef<E[]>([]);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const tRef = useRef(t);
  tRef.current = t;

  const showError = (text: string) => {
    if (batch.current.length > 0) return;
    clearTimeout(toastTimer.current);
    setToast({ id: ++toastId.current, kind: "error", text });
    toastTimer.current = setTimeout(() => setToast(null), ERROR_TOAST_MS);
  };
  const reportFailed = (count: number) => showError(tRef.current("history.delete.failed", { count }));
  /** Commits the pending single deletes now. */
  const flush = () => {
    clearTimeout(batchTimer.current);
    const entries = batch.current;
    batch.current = [];
    setToast((cur) => (cur?.kind === "undo" ? null : cur));
    void optsRef.current.commit(entries, reportFailed);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Leaving the panel commits what is still waiting.
  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
      if (batch.current.length > 0) flushRef.current();
    },
    [],
  );
  const queue = (entries: E[]) => {
    if (entries.length === 0) return;
    opts.hide(entries.map((e) => e.key));
    batch.current = [...batch.current, ...entries];
    clearTimeout(toastTimer.current);
    setToast({ id: ++toastId.current, kind: "undo", text: "" });
    clearTimeout(batchTimer.current);
    batchTimer.current = setTimeout(flush, UNDO_MS);
  };
  const undo = () => {
    clearTimeout(batchTimer.current);
    opts.unhide(batch.current.map((e) => e.key));
    batch.current = [];
    setToast(null);
  };
  return { toast, batch, showError, reportFailed, flush, queue, undo };
}

/** The "N chats deleted - Undo" / error toast at the bottom of the list. */
export function HistoryToast({ toast, count, onUndo }: { toast: HistoryToastState; count: number; onUndo: () => void }) {
  const { t } = useI18n();
  return (
    <div key={toast.id} className={"agent-history-toast" + (toast.kind === "error" ? " is-error" : "")} role="status" aria-live="polite">
      <span className="agent-history-toast-text">{toast.kind === "error" ? toast.text : count === 1 ? t("history.delete.one") : t("history.delete.other", { count })}</span>
      {toast.kind === "undo" && (
        <button type="button" className="agent-history-toast-undo" onClick={onUndo}>
          {t("history.delete.undo")}
        </button>
      )}
      <span className="agent-history-toast-bar" style={{ animationDuration: `${toast.kind === "undo" ? UNDO_MS : ERROR_TOAST_MS}ms` }} />
    </div>
  );
}
