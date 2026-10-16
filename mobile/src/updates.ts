// The phone's self-update: one store shared by the startup sheet, the
// Settings "Updates" section and the nav dot. The Rust side (updater.rs)
// checks GitHub, downloads and verifies the APK; the webview only shows it.
import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createStore } from "./store";
import { platform } from "./remote";
import { t, type Key } from "./i18n";

/** Mirrors `UpdateInfo` in src-tauri/src/updater.rs. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  pageUrl: string;
  size: number;
}

/** Mirrors `UpdateProgress` in src-tauri/src/updater.rs. */
export type UpdateProgress = { stage: "download"; downloaded: number; total: number } | { stage: "verify" };

interface UpdatesState {
  info: UpdateInfo | null;
  currentVersion: string;
  /** Only the phone can install; the desktop dev build just checks. */
  canInstall: boolean;
  busy: "checking" | "installing" | null;
  progress: UpdateProgress | null;
  /** The last check found nothing newer. */
  upToDate: boolean;
  /** Error code from updater.rs (see `errorText`), shown until the next action. */
  error: string | null;
  /** What the last install attempt ended in, besides an error. */
  notice: "needsPermission" | "started" | null;
  /** The startup sheet has an update to offer and wasn't dismissed. */
  sheetPending: boolean;
}

export const updates = createStore<UpdatesState>({
  info: null,
  currentVersion: "",
  canInstall: false,
  busy: null,
  progress: null,
  upToDate: false,
  error: null,
  notice: null,
  sheetPending: false,
});

/** Automatic checks are at most this far apart. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
let lastCheck = 0;
/** The sheet opens by itself once per app start. */
let sheetOffered = false;
let ready: Promise<void> | null = null;

function init(): Promise<void> {
  ready ??= Promise.all([platform().catch(() => "desktop" as const), getVersion().catch(() => "")]).then(([p, v]) => {
    updates.set({ canInstall: p === "mobile", currentVersion: v });
  });
  return ready;
}

/** Asks GitHub for a newer release. A background check stays quiet on failure; the Settings button reports it. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (updates.get().busy) return;
  lastCheck = Date.now();
  updates.set({ busy: "checking", error: null, notice: null });
  await init();
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    updates.set({ info, upToDate: !info, busy: null });
    if (info && !manual && updates.get().canInstall && !sheetOffered) {
      sheetOffered = true;
      updates.set({ sheetPending: true });
    }
  } catch (e) {
    updates.set({ busy: null, error: manual ? String(e) : null });
  }
}

/** The startup/resume check: skipped when one ran recently. */
export function autoCheckForUpdates(): void {
  if (Date.now() - lastCheck >= RECHECK_MS) void checkForUpdates(false);
}

/** Downloads, verifies and opens Android's installer on the update found. */
export async function installUpdate(): Promise<void> {
  if (updates.get().busy) return;
  updates.set({ busy: "installing", progress: null, error: null, notice: null });
  const onProgress = new Channel<UpdateProgress>();
  onProgress.onmessage = (progress) => updates.set({ progress });
  try {
    const outcome = await invoke<"started" | "needsPermission">("update_install", { onProgress });
    updates.set({ busy: null, progress: null, notice: outcome });
  } catch (e) {
    updates.set({ busy: null, progress: null, error: String(e) });
  }
}

export function dismissUpdateSheet(): void {
  updates.set({ sheetPending: false });
}

const ERRORS: Record<string, Key> = {
  notFound: "updErrNotFound",
  rateLimited: "updErrRateLimited",
  network: "updErrNetwork",
  badVersion: "updErrBadVersion",
  untrusted: "updErrUntrusted",
  downloadFailed: "updErrDownload",
  incomplete: "updErrIncomplete",
  checksumsFailed: "updErrChecksums",
  notListed: "updErrChecksums",
  noChecksums: "updErrNoChecksums",
  badSignature: "updErrSignature",
  mismatch: "updErrMismatch",
  noUpdate: "updErrNoUpdate",
  busy: "updErrBusy",
  installFailed: "updErrInstall",
  androidOnly: "updAndroidOnly",
};

/** The translated text for an error code from updater.rs. */
export function errorText(code: string): string {
  return t(ERRORS[code] ?? "updErrGeneric");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
