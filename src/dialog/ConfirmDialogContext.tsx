import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import "./confirm-dialog.css";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmDialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
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

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // Only one dialog at a time: a newer request supersedes (cancels) the
      // one still open, instead of leaving its caller awaiting forever.
      pendingRef.current?.resolve(false);
      const entry: PendingConfirm = { ...options, resolve };
      pendingRef.current = entry;
      setPending(entry);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    pendingRef.current?.resolve(value);
    pendingRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    if (!pending) return;
    confirmBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      // Keep the key from also reaching whatever is behind the modal (a
      // focused terminal would otherwise receive the Enter too).
      e.preventDefault();
      e.stopPropagation();
      settle(e.key === "Enter");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pending, settle]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmDialogCtx.Provider value={value}>
      {children}
      {pending && (
        <div
          className="confirm-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div className="confirm-dialog" role="alertdialog" aria-modal="true">
            {pending.title && <div className="confirm-title">{pending.title}</div>}
            <div className="confirm-message">{pending.message}</div>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" onClick={() => settle(false)}>
                {pending.cancelLabel ?? t("common.cancel")}
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className={"confirm-btn confirm-btn-primary" + (pending.danger ? " is-danger" : "")}
                onClick={() => settle(true)}
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
