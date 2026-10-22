import { Markdown } from "../../src/changelog/markdown";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
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
export function UpdatesPage() {
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
