import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { QrIcon } from "./icons";
import { inspectTicket, myFingerprint, onDeepLink, pair, platform, setPairingBusy, takePendingLink } from "./remote";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Flowcode Mobile";
}

const PREFIX = "flowcode://pair?t=";

interface Proposal {
  ticket: string;
  hostName?: string;
  fingerprint?: string;
  /** This phone's own code, which the desktop shows too. */
  mine?: string;
}

export function PairingScreen({ initialError }: { initialError?: string }) {
  const [mobile, setMobile] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  // Nothing pairs without the user confirming who they are connecting to.
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The latest field values for the async callers (scan result, deep link).
  const nameRef = useRef(name);
  nameRef.current = name;
  const busyRef = useRef(false);

  /** Validates a ticket (QR, link or paste) and asks for confirmation; never pairs by itself. */
  async function propose(ticket: string) {
    const trimmed = ticket.trim();
    if (busyRef.current) return;
    if (!trimmed.startsWith(PREFIX)) {
      setError(t("invalidCode"));
      return;
    }
    setError(undefined);
    setProposal({ ticket: trimmed });
    const [info, mine] = await Promise.all([inspectTicket(trimmed), myFingerprint()]);
    setProposal((p) => (p && p.ticket === trimmed ? { ticket: trimmed, hostName: info?.hostName, fingerprint: info?.fingerprint, mine: mine ?? undefined } : p));
  }
  const proposeRef = useRef(propose);
  proposeRef.current = propose;

  async function confirm() {
    if (busyRef.current || !proposal) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPairingBusy(true);
    try {
      await pair(proposal.ticket, nameRef.current.trim() || defaultDeviceName());
      setProposal(null);
    } catch (e) {
      setError(typeof e === "string" ? e : t("pairFailed"));
      setProposal(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPairingBusy(false);
    }
  }

  useEffect(() => {
    void platform().then((p) => setMobile(p === "mobile"));
    // A flowcode://pair link opened the app (cold start or while running).
    const fromLink = (url: string) => {
      setCode(url);
      void proposeRef.current(url);
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
      await propose(result.content);
    } catch (e) {
      // Cancelling the camera also lands here; only say so for real errors.
      const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
      if (text && !/cancel/i.test(text)) setError(`${t("scanFailed")}: ${text}`);
    }
  }

  if (busy) {
    return (
      <div className="screen pair pair-wait" role="status">
        <span className="spinner" aria-hidden="true" />
        <h1>{t("pairWaiting")}</h1>
        <p className="muted">{t("pairWaitingHint")}</p>
        {proposal?.mine && <p className="fingerprint">{proposal.mine}</p>}
      </div>
    );
  }

  if (proposal) {
    return (
      <div className="screen pair pair-wait">
        <div className="logo" aria-hidden="true">
          <TerminalMark />
        </div>
        <h1>{t("pairConfirmTitle", { host: proposal.hostName ?? t("reconHostFallback") })}</h1>
        {proposal.mine && (
          <p className="muted">
            {t("pairConfirmCode", { code: "" })}
            <b className="fingerprint">{proposal.mine}</b>
          </p>
        )}
        <label className="field">
          <span>{t("deviceName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={40} />
        </label>
        <button type="button" className="btn primary big" onClick={() => void confirm()}>
          {t("pair")}
        </button>
        <button type="button" className="btn big" onClick={() => setProposal(null)}>
          {t("pairCancel")}
        </button>
      </div>
    );
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
          <button type="button" className="btn primary big" onClick={() => void scan()}>
            <QrIcon /> {t("scanQr")}
          </button>
          <div className="or">{t("orPaste")}</div>
        </>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void propose(code);
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
        <button type="submit" className={"btn big " + (mobile ? "" : "primary")} disabled={!code.trim() || !name.trim()}>
          {t("pair")}
        </button>
      </form>
    </div>
  );
}

export function TerminalMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 8 4 4-4 4" />
      <path d="M13 17h5" />
    </svg>
  );
}
