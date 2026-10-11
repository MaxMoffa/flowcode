import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { QrIcon } from "./icons";
import { onDeepLink, pair, platform, setPairingBusy, takePendingLink } from "./remote";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Flowcode Mobile";
}

const PREFIX = "flowcode://pair?t=";

export function PairingScreen({ initialError }: { initialError?: string }) {
  const [mobile, setMobile] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  // The latest field values for the async callers (scan result, deep link).
  const nameRef = useRef(name);
  nameRef.current = name;

  async function submit(ticket: string) {
    const trimmed = ticket.trim();
    if (!trimmed.startsWith(PREFIX)) {
      setError(t("invalidCode"));
      return;
    }
    if (!nameRef.current.trim()) return;
    setError(undefined);
    setBusy(true);
    setPairingBusy(true);
    try {
      await pair(trimmed, nameRef.current);
    } catch (e) {
      setError(typeof e === "string" ? e : t("pairFailed"));
    } finally {
      setBusy(false);
      setPairingBusy(false);
    }
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    void platform().then((p) => setMobile(p === "mobile"));
    // A flowcode://pair link opened the app (cold start or while running).
    const fromLink = (url: string) => {
      setCode(url);
      void submitRef.current(url);
    };
    void takePendingLink().then((url) => url && fromLink(url));
    const off = onDeepLink(fromLink);
    return () => void off.then((f) => f());
  }, []);

  async function scan() {
    setError(undefined);
    try {
      const { scan: doScan, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
      let perm = await checkPermissions();
      if (perm !== "granted") perm = await requestPermissions();
      if (perm !== "granted") {
        setError(t("cameraDenied"));
        return;
      }
      const result = await doScan({ windowed: false, formats: [Format.QRCode] });
      setCode(result.content);
      await submit(result.content);
    } catch (e) {
      // Cancelling the camera also lands here; only say so for real errors.
      const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
      if (text && !/cancel/i.test(text)) setError(`${t("scanFailed")}: ${text}`);
    }
  }

  return (
    <div className="screen pair">
      <div className="pair-hero">
        <div className="logo" aria-hidden="true">
          <TerminalMark />
        </div>
        <h1>{t("welcomeTitle")}</h1>
        <p className="muted">{t("welcomeBody")}</p>
      </div>

      {mobile && (
        <>
          <button type="button" className="btn primary big" disabled={busy} onClick={() => void scan()}>
            <QrIcon /> {t("scanQr")}
          </button>
          <div className="or">{t("orPaste")}</div>
        </>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <label className="field">
          <span>{t("pasteLabel")}</span>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("pastePlaceholder")}
            rows={3}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("deviceName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={40} />
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className={"btn big " + (mobile ? "" : "primary")} disabled={busy || !code.trim() || !name.trim()}>
          {busy ? t("pairing") : t("pair")}
        </button>
      </form>
    </div>
  );
}

function TerminalMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 8 4 4-4 4" />
      <path d="M13 17h5" />
    </svg>
  );
}
