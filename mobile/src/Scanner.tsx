// Full-screen QR scanner. The native camera preview sits behind the webview
// (`windowed: true` makes the webview transparent); this draws the dimmed
// overlay, the viewfinder and the controls on top of it.
import { useEffect, useRef, useState } from "react";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { BackIcon } from "./icons";
import "./pairing.css";

type Stage = "starting" | "scanning" | "denied";

interface Props {
  onResult: (content: string) => void;
  /** Closed without a code: the close button, Back, or a cancelled scan. */
  onClose: () => void;
  /** "Incolla il codice": leave the camera and go to the paste field. */
  onPaste: () => void;
  onError: (message: string) => void;
}

export function Scanner({ onResult, onClose, onPaste, onError }: Props) {
  const [stage, setStage] = useState<Stage>("starting");
  const cb = useRef({ onResult, onClose, onError });
  cb.current = { onResult, onClose, onError };

  useEffect(() => {
    let alive = true;
    const root = document.documentElement;
    let cancelPlugin: (() => Promise<void>) | null = null;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-barcode-scanner");
        cancelPlugin = mod.cancel;
        let perm = await mod.checkPermissions();
        if (perm !== "granted") perm = await mod.requestPermissions();
        if (!alive) return;
        if (perm !== "granted") {
          setStage("denied");
          return;
        }
        setStage("scanning");
        root.classList.add("scanning");
        const result = await mod.scan({ windowed: true, formats: [mod.Format.QRCode] });
        if (alive) cb.current.onResult(result.content);
      } catch (e) {
        if (!alive) return;
        const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
        root.classList.remove("scanning");
        if (/permission/i.test(text)) setStage("denied");
        else if (!text || /cancel/i.test(text)) cb.current.onClose();
        else cb.current.onError(`${t("scanFailed")}: ${text}`);
      }
    })();
    return () => {
      alive = false;
      root.classList.remove("scanning");
      void cancelPlugin?.().catch(() => {});
    };
  }, []);

  const close = () => cb.current.onClose();
  useBackHandler(true, close);

  async function openSettings() {
    try {
      const mod = await import("@tauri-apps/plugin-barcode-scanner");
      await mod.openAppSettings();
    } catch {
      // The text above already says where to find it.
    }
  }

  const denied = stage === "denied";
  return (
    <div className={"scan" + (denied ? " is-denied" : "")} role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <button type="button" className="scan-close" onClick={close} aria-label={t("scanClose")}>
        <BackIcon />
      </button>

      {denied ? (
        <div className="scan-denied">
          <h1 id="scan-title">{t("scanDeniedTitle")}</h1>
          <p className="muted">{t("scanDeniedBody")}</p>
          <button type="button" className="btn primary big" onClick={() => void openSettings()}>
            {t("scanOpenSettings")}
          </button>
          <button type="button" className="btn big" onClick={onPaste}>
            {t("scanPaste")}
          </button>
        </div>
      ) : (
        <>
          <div className="scan-head">
            <h1 id="scan-title">{t("scanTitle")}</h1>
            <p>{t("scanHint")}</p>
          </div>
          <div className="scan-frame" aria-hidden="true">
            <i className="tl" />
            <i className="tr" />
            <i className="bl" />
            <i className="br" />
            <span className="scan-line" />
          </div>
          <div className="scan-foot">
            {stage === "starting" && <p className="scan-status">{t("scanStarting")}</p>}
            <button type="button" className="scan-paste" onClick={onPaste}>
              {t("scanPaste")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
