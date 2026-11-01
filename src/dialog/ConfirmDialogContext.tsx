import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import "./confirm-dialog.css";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Aborting dismisses the dialog as if cancelled (e.g. the request behind it expired). */
  signal?: AbortSignal;
}

export type ConfirmChoice = "confirm" | "cancel" | "alternative";

export interface ConfirmChoiceOptions extends ConfirmOptions {
  alternativeLabel?: string;
}

interface PendingConfirm extends ConfirmChoiceOptions {
  resolve: (value: ConfirmChoice) => void;
  cleanup: () => void;
}

interface ConfirmDialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  choose: (options: ConfirmChoiceOptions) => Promise<ConfirmChoice>;
}

const ConfirmDialogCtx = createContext<ConfirmDialogContextValue | null>(null);

/** In-app confirm dialog: replaces window.confirm so destructive/irreversible
 * actions (closing an unsaved tab, deleting a file) get the app's own
 * themed modal instead of a native OS prompt. */
export function useConfirmDialog() {
  const ctx = useContext(ConfirmDialogCtx);
  if (!ctx) throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  return ctx.confirm;
}

/** A confirmation with an optional third action, such as discarding edits. */
export function useConfirmChoice() {
  const ctx = useContext(ConfirmDialogCtx);
  if (!ctx) throw new Error("useConfirmChoice must be used within ConfirmDialogProvider");
  return ctx.choose;
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  const settle = useCallback((value: ConfirmChoice) => {
    const entry = pendingRef.current;
    pendingRef.current = null;
    entry?.cleanup();
    entry?.resolve(value);
    if (mountedRef.current) setPending(null);
  }, []);

  const choose = useCallback((options: ConfirmChoiceOptions) => {
    return new Promise<ConfirmChoice>((resolve) => {
      // Only one dialog at a time: a newer request supersedes (cancels) the
      // one still open, instead of leaving its caller awaiting forever.
      settle("cancel");
      if (!mountedRef.current || options.signal?.aborted) {
        resolve("cancel");
        return;
      }
      const onAbort = () => {
        if (pendingRef.current === entry) settle("cancel");
      };
      const entry: PendingConfirm = {
        ...options,
        resolve,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort),
      };
      pendingRef.current = entry;
      setPending(entry);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }, [settle]);

  const confirm = useCallback((options: ConfirmOptions) => choose(options).then((choice) => choice === "confirm"), [choose]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settle("cancel");
    };
  }, [settle]);

  useEffect(() => {
    if (!pending) return;
    confirmBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      // Keep the key from also reaching whatever is behind the modal (a
      // focused terminal would otherwise receive the Enter too).
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        settle("cancel");
      } else {
        // Preserve Enter-to-confirm for existing boolean dialogs. A third
        // action also supports keyboard activation of its focused button.
        const focused = pending.alternativeLabel && e.target instanceof Element ? e.target.closest("[data-confirm-choice]")?.getAttribute("data-confirm-choice") : null;
        settle(focused === "alternative" || focused === "cancel" ? focused : "confirm");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pending, settle]);

  const value = useMemo(() => ({ confirm, choose }), [confirm, choose]);

  return (
    <ConfirmDialogCtx.Provider value={value}>
      {children}
      {pending && (
        <div
          className="modal-backdrop confirm-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle("cancel");
          }}
        >
          <div className="modal-panel confirm-dialog" role="alertdialog" aria-modal="true">
            {pending.title && <div className="confirm-title">{pending.title}</div>}
            <div className="confirm-message">{pending.message}</div>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" data-confirm-choice="cancel" onClick={() => settle("cancel")}>
                {pending.cancelLabel ?? t("common.cancel")}
              </button>
              {pending.alternativeLabel && (
                <button type="button" className="confirm-btn" data-confirm-choice="alternative" onClick={() => settle("alternative")}>
                  {pending.alternativeLabel}
                </button>
              )}
              <button
                ref={confirmBtnRef}
                type="button"
                className={"confirm-btn confirm-btn-primary" + (pending.danger ? " is-danger" : "")}
                data-confirm-choice="confirm"
                onClick={() => settle("confirm")}
              >
                {pending.confirmLabel ?? t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmDialogCtx.Provider>
  );
}
