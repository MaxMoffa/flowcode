// "Connection lost" bottom sheet (and its dismissed pill), shown over every
// screen while the link to the desktop is down for longer than a blip.
import { useEffect, useRef, useState } from "react";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useEscape } from "./back";
import { t } from "./i18n";
import { Svg } from "./icons";
import { appResumed, retryNow, useRemoteSelector } from "./remote";
import "./reconnect.css";

/** Shorter outages (a relay hiccup, a quick redial) are not worth a sheet. */
const SHOW_AFTER = 1500;
const FADE = 180;
const DETAILS_KEY = "flowcode.reconnectDetails";

/** Redial now, skipping the backoff, and tell the core the app is in the foreground. */
function retry() {
  void retryNow().catch(() => {});
  void appResumed();
}

function loadDetails(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

function useNavigatorOnline(): boolean {
  const [on, setOn] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return on;
}

const PhoneIcon = () => (
  <Svg size={26} strokeWidth={1.7}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
);

const MonitorIcon = () => (
  <Svg size={26} strokeWidth={1.7}>
    <rect x="3" y="4" width="18" height="12" rx="2.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);

type StepState = "ok" | "fail" | "busy" | "pending";

function Step({ state, label }: { state: StepState; label: string }) {
  return (
    <li className={`rc-step is-${state}`}>
      <span className="rc-bubble" aria-hidden="true">
        {state === "ok" && (
          <Svg size={12} strokeWidth={3}>
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </Svg>
        )}
        {state === "fail" && (
          <Svg size={12} strokeWidth={3}>
            <path d="m6 6 12 12M18 6 6 18" />
          </Svg>
        )}
      </span>
      <span>{label}</span>
    </li>
  );
}

export function Reconnect() {
  const status = useRemoteSelector((s) => s.status);
  const hostName = useRemoteSelector((s) => s.hostName);
  const error = useRemoteSelector((s) => s.error);
  const phase = useRemoteSelector((s) => s.phase);
  const attempt = useRemoteSelector((s) => s.attempt);
  const retryAt = useRemoteSelector((s) => s.retryAt);
  const phoneOnline = useNavigatorOnline();
  const down = status === "connecting" || status === "offline";

  // `armed` is the debounced "down" flag; `mounted` outlives it for the fade-out.
  const [armed, setArmed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [details, setDetails] = useState(loadDetails);
  const [now, setNow] = useState(() => Date.now());
  const primary = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!down) {
      setArmed(false);
      setDismissed(false);
      return;
    }
    const id = setTimeout(() => setArmed(true), SHOW_AFTER);
    return () => clearTimeout(id);
  }, [down]);

  useEffect(() => {
    if (armed) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), FADE);
    return () => clearTimeout(id);
  }, [armed]);

  // Live countdown while waiting for the next attempt.
  useEffect(() => {
    if (!armed || phase !== "waiting") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [armed, phase]);

  const open = armed && !dismissed;
  useEscape(open && mounted, () => setDismissed(true));
  useEffect(() => {
    if (open) (primary.current && !primary.current.disabled ? primary.current : sheet.current)?.focus();
  }, [open]);

  if (!mounted) return null;

  const host = hostName ?? t("reconHostFallback");
  const dialing = phase === "dialing" || phase === "handshake" || (phase === undefined && status === "connecting");
  const seconds = Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000));
  const subtitle = !phoneOnline ? t("reconPhoneOffline") : phase === "waiting" ? t("reconRetryIn", { s: seconds, n: attempt ?? 1 }) : t("reconSearching", { host });

  const net: StepState = phoneOnline ? "ok" : "fail";
  const find: StepState = !phoneOnline ? "pending" : phase === "handshake" ? "ok" : dialing ? "busy" : "pending";
  const auth: StepState = phoneOnline && phase === "handshake" ? "busy" : "pending";

  function toggleDetails() {
    const next = !details;
    setDetails(next);
    try {
      localStorage.setItem(DETAILS_KEY, next ? "1" : "0");
    } catch {
      // Only a remembered preference.
    }
  }

  const leaving = armed ? "" : " is-leaving";

  if (dismissed) {
    return (
      <div className={`rc-pill${leaving}`}>
        <button type="button" className="rc-pill-text" onClick={() => setDismissed(false)}>
          <i aria-hidden="true" />
          <span>{t("reconPill", { host })}</span>
        </button>
        <button type="button" className="rc-pill-retry" onClick={retry}>
          {t("reconPillRetry")}
        </button>
      </div>
    );
  }

  return (
    <AdaptiveSheet open={open} onClose={() => setDismissed(true)} family="rc" variant="dialog" dragEnabled={mounted} labelledBy="rc-title" scrimClass={leaving.trim()} panelClass={leaving.trim()} panelRef={sheet}>
      <div className="rc-handle" aria-hidden="true" />
      <div className="rc-art" aria-hidden="true">
        <div className="rc-tile">
          <PhoneIcon />
        </div>
        <svg className="rc-line is-live" width="44" height="4" viewBox="0 0 44 4">
          <line x1="1" y1="2" x2="43" y2="2" />
        </svg>
        <span className="rc-x">×</span>
        <svg className="rc-line is-faint" width="44" height="4" viewBox="0 0 44 4">
          <line x1="1" y1="2" x2="43" y2="2" />
        </svg>
        <div className="rc-tile">
          <MonitorIcon />
        </div>
      </div>
      <h2 id="rc-title" className="rc-title">
        {t("reconLost")}
      </h2>
      <p className="rc-sub" aria-live="polite">
        {subtitle}
      </p>

      {details && (
        <div className="rc-details">
          <ul>
            <Step state={net} label={t("reconPhoneNet")} />
            <Step state={find} label={t("reconFinding")} />
            <Step state={auth} label={t("reconAuth")} />
          </ul>
          <p className="rc-hint">{t("reconHint")}</p>
          {error && <p className="rc-error">{error}</p>}
        </div>
      )}

      <button ref={primary} type="button" className="btn big primary rc-primary" disabled={dialing} onClick={retry}>
        {dialing ? t("reconRetrying") : t("reconRetry")}
      </button>
      <div className="rc-row">
        <button type="button" className="btn ghost" aria-expanded={details} onClick={toggleDetails}>
          {details ? t("reconHideDetails") : t("reconDetails")}
        </button>
        <button type="button" className="btn ghost" onClick={() => setDismissed(true)}>
          {t("reconLastData")}
        </button>
      </div>
    </AdaptiveSheet>
  );
}
