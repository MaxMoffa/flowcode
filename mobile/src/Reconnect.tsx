// The compact "reconnecting" pill, for the screens the link screen does not cover
// (terminals, Settings, the wide layout); chats show their own offline strip.
import { retry } from "./LinkScreen";
import { useLinkDown } from "./linkDown";
import { t } from "./i18n";
import { useRemoteSelector } from "./remote";
import "./reconnect.css";

export function Reconnect() {
  const hostName = useRemoteSelector((s) => s.hostName);
  if (!useLinkDown()) return null;
  const host = hostName ?? t("reconHostFallback");
  return (
    <div className="rc-pill">
      <span className="rc-pill-text">
        <i aria-hidden="true" />
        <span>{t("reconPill", { host })}</span>
      </span>
      <button type="button" className="rc-pill-retry" onClick={retry}>
        {t("reconPillRetry")}
      </button>
    </div>
  );
}
