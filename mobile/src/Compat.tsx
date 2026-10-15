// What to say when the connected desktop is older than this phone: a screen
// that blocks everything when the protocol is too old, and a dismissable banner
// when only some features are missing (their UI is hidden where they live).
import { t } from "./i18n";
import { CAP_LABELS, checkCompat, type HostInfo } from "./compatCheck";
import { CloseIcon } from "./icons";
import { dismissCompat, retryNow } from "./remote";

function versionText(host: HostInfo): string {
  return host.appVersion ? `Flowcode ${host.appVersion}` : t("compatVersionUnknown");
}

/** Replaces the whole app: the desktop speaks a protocol this phone no longer understands. */
export function IncompatibleScreen({ host, hostName }: { host: HostInfo; hostName?: string }) {
  return (
    <div className="screen compat-block" role="alert">
      <h1>{t("compatBlockedTitle")}</h1>
      <p>{t("compatBlockedBody", { host: hostName ?? t("reconHostFallback") })}</p>
      <p className="compat-ver">{t("compatDesktopVersion", { version: versionText(host), proto: host.proto })}</p>
      <button type="button" className="btn primary big" onClick={() => void retryNow().catch(() => {})}>
        {t("reconRetry")}
      </button>
    </div>
  );
}

/** Some features need a newer desktop; the phone works, minus those. */
export function CompatBanner({ host, hostName }: { host: HostInfo; hostName?: string }) {
  const { missing } = checkCompat(host);
  const features = [...new Set(missing.map((c) => t(CAP_LABELS[c])))].join(", ");
  return (
    <div className="compat-banner" role="status">
      <div className="compat-tx">
        <b>{t("compatPartialTitle", { host: hostName ?? t("reconHostFallback") })}</b>
        <span>{t("compatPartialBody", { features, version: versionText(host) })}</span>
      </div>
      <button type="button" className="compat-x" aria-label={t("closeViewer")} onClick={dismissCompat}>
        <CloseIcon />
      </button>
    </div>
  );
}
