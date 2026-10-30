import { Markdown } from "../../src/changelog/markdown";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { useEffect, useRef } from "react";
import { t } from "./i18n";
import { desktopUpdateCheck, desktopUpdateInstall, useRemoteSelector, useSupports } from "./remote";
import { Group } from "./SettingsControls";
import { checkForUpdates, dismissUpdateSheet, errorText, formatBytes, installUpdate, updates, type UpdateInfo, type UpdateProgress } from "./updates";

function progressLabel(progress: UpdateProgress | null, size: number): { label: string; fraction: number | null } {
  if (progress?.stage === "download") {
    const total = progress.total || size;
    return {
      fraction: total > 0 ? Math.min(1, progress.downloaded / total) : null,
      label: total > 0 ? t("updDownloading", { done: formatBytes(progress.downloaded), total: formatBytes(total) }) : t("updDownloadingNoTotal", { done: formatBytes(progress.downloaded) }),
    };
  }
  if (progress?.stage === "verify") return { label: t("updVerifying"), fraction: 1 };
  return { label: t("updStarting"), fraction: 0 };
}

function ProgressBar({ progress, size }: { progress: UpdateProgress | null; size: number }) {
  const { label, fraction } = progressLabel(progress, size);
  return (
    <div className="upd-progress" role="progressbar" aria-valuetext={label}>
      <div className="upd-track">
        <div className={"upd-fill" + (fraction === null ? " indeterminate" : "")} style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </div>
      <span className="prof-note">{label}</span>
    </div>
  );
}

/** Release notes, the install progress, the outcome message and the install button: shared by the sheet and the Settings section. */
function InstallArea({ info }: { info: UpdateInfo }) {
  const { busy, progress, error, notice, canInstall } = updates.use();
  const installing = busy === "installing";
  return (
    <>
      {info.notes.trim() && (
        <div className="upd-notes">
          <Markdown source={info.notes.trim()} />
        </div>
      )}
      {installing && <ProgressBar progress={progress} size={info.size} />}
      {error && (
        <p className="prof-note" role="alert">
          {errorText(error)}
        </p>
      )}
      {notice === "needsPermission" && <p className="prof-note">{t("updNeedsPermission")}</p>}
      {notice === "started" && <p className="prof-note">{t("updStarted")}</p>}
      {!canInstall && <p className="prof-note">{t("updAndroidOnly")}</p>}
      {canInstall && !installing && (
        <button type="button" className="btn primary big" onClick={() => void installUpdate()}>
          {error || notice === "needsPermission" ? t("updRetry") : t("updInstall")}
        </button>
      )}
    </>
  );
}

/** Settings > Updates: versions, notes, the manual check and the install. */
function PhoneUpdates() {
  const { info, currentVersion, busy, upToDate, error } = updates.use();
  const checking = busy === "checking";
  return (
    <>
      <Group title={t("updTitle")}>
        <div className="set-row">
          <span className="set-label">{t("updCurrent")}</span>
          <span className="set-value">{currentVersion || "..."}</span>
        </div>
        {info && (
          <div className="set-row">
            <span className="set-label">{t("updNew")}</span>
            <span className="set-value">{info.version}</span>
          </div>
        )}
        <div className="set-block">
          {upToDate && !checking && <p className="prof-note">{t("updUpToDate")}</p>}
          {!info && error && (
            <p className="prof-note" role="alert">
              {errorText(error)}
            </p>
          )}
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void checkForUpdates(true)}>
            {checking ? t("updChecking") : t("updCheck")}
          </button>
        </div>
      </Group>
      {info && (
        <Group title={t("updNotes")}>
          <div className="set-block">
            <InstallArea info={info} />
          </div>
        </Group>
      )}
    </>
  );
}

/** Settings > Updates, second group: updating the desktop's Flowcode from the phone. */
function DesktopUpdateGroup() {
  const du = useRemoteSelector((s) => s.desktopUpdate);
  const status = useRemoteSelector((s) => s.status);
  const host = useRemoteSelector((s) => s.host);
  const hostName = useRemoteSelector((s) => s.hostName);
  const online = status === "online";
  const asked = useRef(false);
  const wasInstalling = useRef(false);
  if (du?.state === "installing") wasInstalling.current = true;
  useEffect(() => {
    if (online && !asked.current) {
      asked.current = true;
      desktopUpdateCheck();
    }
  }, [online]);
  const state = du?.state ?? "idle";
  const current = host?.appVersion || du?.currentVersion || "...";
  const installing = state === "installing" || (wasInstalling.current && !online);
  const restarted = online && wasInstalling.current && !!du?.version && host?.appVersion === du.version;
  const install = () => {
    if (!window.confirm(t("updDesktopConfirm", { version: du?.version ?? "" }))) return;
    wasInstalling.current = true;
    desktopUpdateInstall();
  };
  const progress: UpdateProgress | null = du?.stage === "download" ? { stage: "download", downloaded: du.downloaded ?? 0, total: du.total ?? 0 } : du?.stage === "verify" ? { stage: "verify" } : null;
  return (
    <Group title={t("updDesktopTitle")}>
      <div className="set-row">
        <span className="set-label">{hostName || t("updDesktopTitle")}</span>
        <span className="set-value">{current}</span>
      </div>
      {du && (state === "available" || installing) && du.version && (
        <div className="set-row">
          <span className="set-label">{t("updDesktopNew")}</span>
          <span className="set-value">{du.version}</span>
        </div>
      )}
      <div className="set-block">
        {restarted && <p className="prof-note">{t("updDesktopDone", { version: du?.version ?? "" })}</p>}
        {!restarted && state === "checking" && <p className="prof-note">{t("updDesktopChecking")}</p>}
        {!restarted && state === "upToDate" && !installing && <p className="prof-note">{t("updDesktopUpToDate")}</p>}
        {!restarted && installing && !online && <p className="prof-note">{t("updDesktopRestarting")}</p>}
        {!restarted && installing && online && (du?.stage === "install" || !du?.stage ? <p className="prof-note">{t("updDesktopInstalling")}</p> : <ProgressBar progress={progress} size={du?.size ?? 0} />)}
        {!restarted && state === "error" && (
          <>
            <p className="prof-note" role="alert">
              {du?.error}
            </p>
            <button type="button" className="btn" disabled={!online} onClick={() => desktopUpdateCheck()}>
              {t("updRetry")}
            </button>
          </>
        )}
        {!restarted && state === "available" && !installing && (
          <>
            {du?.notes?.trim() && (
              <div className="upd-notes">
                <Markdown source={du.notes.trim()} />
              </div>
            )}
            {!du?.allowed && <p className="prof-note">{t("updDesktopNotAllowed")}</p>}
            <button type="button" className="btn primary big" disabled={!du?.allowed || !online} onClick={install}>
              {t("updDesktopInstall")}
            </button>
          </>
        )}
      </div>
    </Group>
  );
}

/** Settings > Updates: the phone's app, then (when the desktop can) the desktop's. */
export function UpdatesPage() {
  const canDesktop = useSupports("desktopUpdate");
  const known = useRemoteSelector((s) => s.host !== null);
  return (
    <>
      <PhoneUpdates />
      {canDesktop && known && <DesktopUpdateGroup />}
    </>
  );
}

/** The bottom sheet that offers a found update once per app start. */
export function UpdateSheet() {
  const { info, busy } = updates.use();
  const installing = busy === "installing";
  // No dismissing mid-download: the sheet is where the progress shows.
  const close = () => {
    if (!installing) dismissUpdateSheet();
  };
  useBackHandler(true, close);
  useEscape(true, close);
  if (!info) return null;
  return (
    <AdaptiveSheet open family="nts" variant="dialog" onClose={close} dragEnabled={!installing} label={t("updSheetTitle")}>
      <div className="nts-grab" aria-hidden="true" />
      <h2>{t("updSheetTitle")}</h2>
      <p className="prof-note">{t("updSheetBody", { version: info.version, current: info.currentVersion })}</p>
      <InstallArea info={info} />
      {!installing && (
        <button type="button" className="btn ghost" onClick={close}>
          {t("updLater")}
        </button>
      )}
    </AdaptiveSheet>
  );
}
