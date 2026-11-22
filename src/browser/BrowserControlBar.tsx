import { useI18n } from "../i18n";
import { cliName } from "../agents/cliInfo";
import { formatCompactDuration } from "../lib/time";
import { useSecondTick } from "../lib/useSecondTick";
import type { PageControl } from "./browserStore";
import "./browser-control.css";

/** The agent's name for a page's control: its cli, else a generic word. */
export function controlAgentName(control: PageControl, fallback: string): string {
  return control.agent ? cliName(control.agent) : fallback;
}

/** Amber (green while paused) ring around the page: the native view is shrunk by `ring` px so it shows. `bottom` leaves the strip under the view free. */
export function ControlRing({ paused, bottom }: { paused: boolean; bottom: number }) {
  return <div className={"bctl-ring" + (paused ? " is-paused" : "")} style={{ bottom }} aria-hidden="true" data-cover-ignore />;
}

/** The strip under the page while an agent drives it: who, the last action, and the way to take the page back. */
export function ControlBar({ control, onStop, onGiveBack, onTakeAway }: { control: PageControl; onStop: () => void; onGiveBack: () => void; onTakeAway: () => void }) {
  const { t } = useI18n();
  useSecondTick();
  const name = controlAgentName(control, t("browserControl.anAgent"));
  const letter = (control.agent ? cliName(control.agent) : name).charAt(0).toUpperCase();
  if (control.paused) {
    return (
      <div className="bctl-bar is-paused" role="status" data-cover-ignore>
        <span className="bctl-bar-av">II</span>
        <div className="bctl-bar-text">
          <b>{t("browserControl.paused.title")}</b>
          <small>{t("browserControl.paused.sub", { agent: name })}</small>
        </div>
        <button type="button" className="bctl-bar-btn is-ghost" onClick={onTakeAway}>
          {t("browserControl.takeAway")}
        </button>
        <button type="button" className="bctl-bar-btn is-main" onClick={onGiveBack}>
          {t("browserControl.giveBack")}
        </button>
      </div>
    );
  }
  const last = control.lastAction;
  return (
    <div className="bctl-bar" role="status" data-cover-ignore>
      <span className="bctl-bar-av">{letter}</span>
      <div className="bctl-bar-text">
        <b>{t("browserControl.using", { agent: name })}</b>
        <small>{last ? `${last.summary} · ${t("browserControl.ago", { time: formatCompactDuration(Date.now() - last.at) })}` : t("browserControl.waiting")}</small>
      </div>
      <button type="button" className="bctl-bar-btn is-stop" onClick={onStop}>
        {t("browserControl.stop")}
      </button>
    </div>
  );
}
