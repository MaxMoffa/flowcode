import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readString, writeString } from "../lib/storage";
import { useI18n } from "../i18n";
import "./update-dialog.css";

/** Mirrors `UpdateInfo` in src-tauri/src/updater.rs. */
export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string;
  page_url: string;
  size: number;
}

/** Mirrors `UpdateProgress` in src-tauri/src/updater.rs. */
type UpdateProgress = { stage: "download"; downloaded: number; total: number } | { stage: "verify" } | { stage: "install" };

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress: UpdateProgress | null }
  | { kind: "error"; message: string; info?: UpdateInfo };

interface UpdateContextValue {
  status: UpdateStatus;
  /** Asks GitHub for a newer release. `manual` (the Settings button) always
   * shows the dialog when there is one - even for a version skipped before. */
  check: (manual: boolean) => Promise<void>;
  /** Reopens the dialog for an update already found. */
  openDialog: () => void;
}

const SKIPPED_VERSION_KEY = "flowcode.update.skippedVersion";
/** Long enough for the first window to settle before hitting the network. */
const STARTUP_CHECK_DELAY_MS = 4000;

const UpdateCtx = createContext<UpdateContextValue | null>(null);

export function useUpdater() {
  const ctx = useContext(UpdateCtx);
  if (!ctx) throw new Error("useUpdater must be used within UpdateProvider");
  return ctx;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Update check on startup (main window only) and on demand, plus the
 * dialog that offers it and shows the download. Installing hands off to the
 * installer, which quits and relaunches Flowcode - see updater.rs. */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const check = useCallback(async (manual: boolean) => {
    const current = statusRef.current.kind;
    if (current === "checking" || current === "installing") return;
    setStatus({ kind: "checking" });
    try {
      const info = await invoke<UpdateInfo | null>("update_check");
      if (!info) {
        setStatus({ kind: "upToDate" });
        return;
      }
      setStatus({ kind: "available", info });
      if (manual || readString(SKIPPED_VERSION_KEY) !== info.version) setDialogOpen(true);
    } catch (e) {
      // A failed background check stays quiet (offline, rate-limited...);
      // only the Settings button reports it.
      setStatus(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    const timer = setTimeout(() => void check(false), STARTUP_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [check]);

  async function install(info: UpdateInfo) {
    setStatus({ kind: "installing", info, progress: null });
    const onProgress = new Channel<UpdateProgress>();
    onProgress.onmessage = (progress) => setStatus({ kind: "installing", info, progress });
    try {
      // Only returns on failure: on success the app quits for the installer.
      await invoke("update_install", { onProgress });
    } catch (e) {
      setStatus({ kind: "error", message: String(e), info });
    }
  }

  function skip(info: UpdateInfo) {
    writeString(SKIPPED_VERSION_KEY, info.version);
    setDialogOpen(false);
  }

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const value = useMemo(() => ({ status, check, openDialog }), [status, check, openDialog]);

  const dialogInfo =
    status.kind === "available" || status.kind === "installing" ? status.info : status.kind === "error" ? status.info : undefined;

  return (
    <UpdateCtx.Provider value={value}>
      {children}
      {dialogOpen && dialogInfo && (
        <div className="confirm-backdrop">
          <div className="confirm-dialog update-dialog" role="alertdialog" aria-modal="true">
            <div className="confirm-title">{t("update.title")}</div>
            <div className="confirm-message">
              {t("update.message", { version: dialogInfo.version, current: dialogInfo.current_version })}
            </div>
            {dialogInfo.notes.trim() && <div className="update-notes">{dialogInfo.notes.trim()}</div>}
            {status.kind === "installing" && <UpdateProgressBar progress={status.progress} size={dialogInfo.size} />}
            {status.kind === "error" && <div className="update-error">{status.message}</div>}
            <div className="confirm-actions">
              {status.kind !== "installing" && (
                <>
                  <button type="button" className="confirm-btn" onClick={() => skip(dialogInfo)}>
                    {t("update.skip")}
                  </button>
                  <button type="button" className="confirm-btn" onClick={() => setDialogOpen(false)}>
                    {t("update.later")}
                  </button>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-primary"
                    autoFocus
                    onClick={() => void install(dialogInfo)}
                  >
                    {status.kind === "error" ? t("update.retry") : t("update.now")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </UpdateCtx.Provider>
  );
}

function UpdateProgressBar({ progress, size }: { progress: UpdateProgress | null; size: number }) {
  const { t } = useI18n();
  let label = t("update.progress.start");
  let fraction: number | null = 0;
  if (progress?.stage === "download") {
    const total = progress.total || size;
    fraction = total > 0 ? Math.min(1, progress.downloaded / total) : null;
    label =
      total > 0
        ? t("update.progress.downloadOf", { done: formatBytes(progress.downloaded), total: formatBytes(total) })
        : t("update.progress.download", { done: formatBytes(progress.downloaded) });
  } else if (progress?.stage === "verify") {
    label = t("update.progress.verify");
    fraction = 1;
  } else if (progress?.stage === "install") {
    label = t("update.progress.install");
    fraction = 1;
  }
  return (
    <div className="update-progress">
      <div className="update-progress-track">
        <div
          className={"update-progress-fill" + (fraction === null ? " is-indeterminate" : "")}
          style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>
      <div className="update-progress-label">{label}</div>
    </div>
  );
}
