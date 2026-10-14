import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { BackIcon, QrIcon, Svg } from "./icons";
import logo from "./assets/flowcode-icon.svg";
import { Scanner } from "./Scanner";
import { cancelPair, inspectTicket, markFirstConnect, myFingerprint, onDeepLink, pair, platform, setPairingBusy, takePendingLink } from "./remote";
import "./pairing.css";

/** The desktop gives up on an unanswered request after about this long. */
const EXPIRES_S = 60;
const SUCCESS_MS = 1600;

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

/** First pairing, or (with onClose) adding another computer while one is paired. */
export function PairingScreen({ initialError, initialLink, onClose }: { initialError?: string; initialLink?: string | null; onClose?: () => void }) {
  const [mobile, setMobile] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  // The dedicated page for the wait on the desktop, its outcome included.
  const [wait, setWait] = useState<{ stage: "waiting" | "done" | "failed"; message?: string; detail?: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<"cancel" | "timeout" | null>(null);
  const [error, setError] = useState<string | undefined>(initialError);
  // Nothing pairs without the user confirming who they are connecting to.
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The latest field values for the async callers (scan result, deep link).
  const nameRef = useRef(name);
  nameRef.current = name;
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
    endRef.current = null;
    setWait({ stage: "waiting" });
    setError(undefined);
    setPairingBusy(true);
    markFirstConnect(true);
    try {
      await pair(proposal.ticket, nameRef.current.trim() || defaultDeviceName());
      setWait({ stage: "done" });
      await new Promise((r) => setTimeout(r, SUCCESS_MS));
      setProposal(null);
      setWait(null);
      onCloseRef.current?.();
    } catch (e) {
      markFirstConnect(false);
      const why = endRef.current;
      if (why === "cancel") {
        setProposal(null);
        setWait(null);
      } else {
        setWait({
          stage: "failed",
          message: why === "timeout" ? t("pairTimedOut") : t("pairRefused"),
          detail: why === null && typeof e === "string" ? e : undefined,
        });
      }
    } finally {
      busyRef.current = false;
      setPairingBusy(false);
    }
  }

  function endWait(why: "cancel" | "timeout") {
    endRef.current = why;
    void cancelPair();
  }

  function retry() {
    setWait(null);
    setProposal(null);
    setError(undefined);
    if (mobile) setScanning(true);
  }

  useEffect(() => {
    void platform().then((p) => setMobile(p === "mobile"));
    // A flowcode://pair link opened the app (cold start or while running).
    const fromLink = (url: string) => {
      setCode(url);
      void proposeRef.current(url);
    };
    void takePendingLink().then((url) => url && fromLink(url));
    if (initialLink) fromLink(initialLink);
    const off = onDeepLink(fromLink);
    return () => void off.then((f) => f());
  }, []);

  if (scanning) {
    return (
      <Scanner
        onResult={(content) => {
          setScanning(false);
          setCode(content);
          void propose(content);
        }}
        onClose={() => setScanning(false)}
        onPaste={() => {
          setScanning(false);
          setTimeout(() => pasteRef.current?.focus(), 50);
        }}
        onError={(message) => {
          setScanning(false);
          setError(message);
        }}
      />
    );
  }

  if (wait) {
    return <PairWait host={proposal?.hostName ?? t("reconHostFallback")} mine={proposal?.mine} wait={wait} onCancel={() => endWait("cancel")} onExpire={() => endWait("timeout")} onRetry={retry} />;
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
      {onClose && (
        <button type="button" className="pair-close" aria-label={t("back")} onClick={onClose}>
          <BackIcon />
        </button>
      )}
      <div className="pair-hero">
        <div className="logo" aria-hidden="true">
          <TerminalMark />
        </div>
        <h1>{onClose ? t("addComputerTitle") : t("welcomeTitle")}</h1>
        <p className="muted">{t("welcomeBody")}</p>
      </div>

      {mobile && (
        <>
          <button type="button" className="btn primary big" onClick={() => setScanning(true)}>
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
            ref={pasteRef}
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

interface WaitProps {
  host: string;
  mine?: string;
  wait: { stage: "waiting" | "done" | "failed"; message?: string; detail?: string };
  onCancel: () => void;
  onExpire: () => void;
  onRetry: () => void;
}

/** The page shown from "Collega" until the desktop answers: its code, a countdown, the outcome. */
function PairWait({ host, mine, wait, onCancel, onExpire, onRetry }: WaitProps) {
  const [left, setLeft] = useState(EXPIRES_S);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const waiting = wait.stage === "waiting";

  useEffect(() => {
    if (!waiting) return;
    setLeft(EXPIRES_S);
    const end = Date.now() + EXPIRES_S * 1000;
    const id = setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(id);
        expire.current();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [waiting]);

  if (wait.stage === "done") {
    return (
      <div className="screen pair pair-wait pw" role="status">
        <div className="pw-check" aria-hidden="true">
          <Svg size={34} strokeWidth={2.5}>
            <path d="m5 12.500 4.500 4.500L19 7.500" />
          </Svg>
        </div>
        <h1>{t("pairDone", { host })}</h1>
      </div>
    );
  }

  if (wait.stage === "failed") {
    return (
      <div className="screen pair pair-wait pw" role="alert">
        <div className="pw-check is-fail" aria-hidden="true">
          <Svg size={30} strokeWidth={2.5}>
            <path d="m6 6 12 12M18 6 6 18" />
          </Svg>
        </div>
        <h1>{t("pairFailedTitle")}</h1>
        <p className="pw-body">{wait.message}</p>
        {wait.detail && <p className="pw-expires">{wait.detail}</p>}
        <button type="button" className="btn primary big" onClick={onRetry}>
          {t("pairRetry")}
        </button>
      </div>
    );
  }

  return (
    <div className="screen pair pair-wait pw" role="status">
      <img className="pw-logo" src={logo} alt="" />
      <h1>{t("pairWaitTitle")}</h1>
      <p className="pw-host">{host}</p>
      {mine && (
        <div className="pw-code">
          <small>{t("pairWaitCode")}</small>
          <b aria-label={mine.split("").join(" ")}>{mine}</b>
        </div>
      )}
      <p className="pw-body">{t("pairWaitBody", { host })}</p>
      <div className="pw-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="pw-bar" aria-hidden="true">
        <i style={{ width: `${(left / EXPIRES_S) * 100}%` }} />
      </div>
      <p className="pw-expires">{t("pairExpires", { s: left })}</p>
      <button type="button" className="btn big" onClick={onCancel}>
        {t("pairCancel")}
      </button>
    </div>
  );
}

export function TerminalMark() {
  return (
    <Svg size={28} strokeWidth={2}>
      <path d="m6 8 4 4-4 4" />
      <path d="M13 17h5" />
    </Svg>
  );
}
