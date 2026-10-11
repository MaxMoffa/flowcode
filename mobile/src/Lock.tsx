import { useEffect, useState } from "react";
import { t } from "./i18n";
import { TerminalMark } from "./Pairing";
import { unlock, verify } from "./applock";

export function LockScreen() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function attempt() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    if (await verify()) unlock();
    else {
      setFailed(true);
      setBusy(false);
    }
  }

  // Prompt once as soon as the lock appears; after that the button retries.
  useEffect(() => {
    void attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="lock" role="dialog" aria-modal="true" aria-label={t("lockTitle")}>
      <div className="logo" aria-hidden="true">
        <TerminalMark />
      </div>
      <h1>{t("lockTitle")}</h1>
      <button type="button" className="btn primary big" disabled={busy} onClick={() => void attempt()}>
        {t("unlock")}
      </button>
      <p className="muted lock-error" role="alert">
        {failed ? t("unlockFailed") : ""}
      </p>
    </div>
  );
}
