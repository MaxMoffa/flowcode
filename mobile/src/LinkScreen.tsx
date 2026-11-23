// Full page for the main pages while the link to the computer is down: replaces the old
// "connection lost" sheet. The computer switcher stays usable, so a dead PC can be left at once.
import { useEffect, useState } from "react";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { t } from "./i18n";
import { MonitorTileIcon, PhoneTileIcon, Svg } from "./icons";
import { appResumed, retryNow, useRemoteSelector } from "./remote";
import "./link-screen.css";

/** After this long down the actions appear (at once while waiting between attempts). */
const SLOW_AFTER = 4000;

/** Redial now, skipping the backoff, and tell the core the app is in the foreground. */
export function retry() {
  void retryNow().catch(() => {});
  void appResumed();
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

type StepState = "ok" | "fail" | "busy" | "pending";

function Step({ state, label }: { state: StepState; label: string }) {
  return (
    <li className={`ls-step is-${state}`}>
      <span className="ls-bubble" aria-hidden="true">
        {state === "ok" && (
          <Svg size={11} strokeWidth={3.2}>
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </Svg>
        )}
        {state === "fail" && (
          <Svg size={11} strokeWidth={3.2}>
            <path d="m6 6 12 12M18 6 6 18" />
          </Svg>
        )}
      </span>
      <span>{label}</span>
    </li>
  );
}

export function LinkScreen({ hostName, onAddComputer }: { hostName?: string; onAddComputer: () => void }) {
  const status = useRemoteSelector((s) => s.status);
  const error = useRemoteSelector((s) => s.error);
  const phase = useRemoteSelector((s) => s.phase);
  const attempt = useRemoteSelector((s) => s.attempt);
  const retryAt = useRemoteSelector((s) => s.retryAt);
  const wasOnline = useRemoteSelector((s) => s.wasOnline);
  const phoneOnline = useNavigatorOnline();
  const [switcher, setSwitcher] = useState(false);
  const [details, setDetails] = useState(false);
  const [slow, setSlow] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER);
    return () => clearTimeout(id);
  }, []);

  // Live countdown while waiting for the next attempt.
  useEffect(() => {
    if (phase !== "waiting") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const host = hostName ?? t("reconHostFallback");
  const dialing = phase === "dialing" || phase === "handshake" || (phase === undefined && status === "connecting");
  const seconds = Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000));
  const hint = !phoneOnline ? t("reconPhoneOffline") : phase === "waiting" ? t("reconRetryIn", { s: seconds, n: attempt ?? 1 }) : slow ? t("linkSlow") : t("linkHint");
  const showActions = slow || phase === "waiting";

  // Same mapping as the old sheet: the phone's network, then the search, then the handshake.
  const net: StepState = phoneOnline ? "ok" : "fail";
  const find: StepState = !phoneOnline ? "pending" : phase === "handshake" ? "ok" : dialing ? "busy" : "pending";
  const auth: StepState = phoneOnline && phase === "handshake" ? "busy" : "pending";

  return (
    <>
      <div className="hm-aurora ls-aurora" aria-hidden="true" />
      <header className="hm-top">
        <ComputerSwitcher hostName={hostName} onAdd={onAddComputer} open={switcher} onOpenChange={setSwitcher} />
      </header>
      <div className="hm-top-space" />
      <section className="ls-body" aria-busy="true">
        <div className="ls-devs" aria-hidden="true">
          <div className="ls-dev">
            <PhoneTileIcon />
          </div>
          <div className="ls-wire" />
          <div className="ls-dev">
            <MonitorTileIcon />
          </div>
        </div>
        <h1 className="ls-title">{t(wasOnline ? "linkReconnecting" : "linkConnecting", { host })}</h1>
        <p className="ls-hint" aria-live="polite">
          {hint}
        </p>
        <ul className="ls-steps">
          <Step state={net} label={t("reconPhoneNet")} />
          <Step state={find} label={t("reconFinding")} />
          <Step state={auth} label={t("reconAuth")} />
        </ul>
        <div className={"ls-acts" + (showActions ? " is-on" : "")} inert={!showActions}>
          <button type="button" className="btn primary" disabled={dialing} onClick={retry}>
            {dialing ? t("reconRetrying") : t("reconRetry")}
          </button>
          <button type="button" className="btn" onClick={() => setSwitcher(true)}>
            {t("linkOther")}
          </button>
        </div>
        <div className={"ls-det" + (showActions ? " is-on" : "")}>
          <button type="button" className="ls-det-toggle" aria-expanded={details} inert={!showActions} onClick={() => setDetails(!details)}>
            {details ? t("reconHideDetails") : t("reconDetails")}
          </button>
          {details && (
            <pre className="ls-det-pre">
              {t("linkAttempt")}: {attempt ?? 1}
              {"\n"}
              {t("linkPhase")}: {phase ?? status}
              {error ? `\n${error}` : ""}
            </pre>
          )}
        </div>
      </section>
    </>
  );
}
