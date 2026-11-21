import { useI18n } from "../i18n";
import "./crash-dialog.css";
import "./crash-diagnosis.css";
import { showCrashReport } from "./diagnosis";

/** The strip on top of a diagnosis chat: what it is for, and the way back to the report. */
export function DiagnosisBanner({ when }: { when: string }) {
  const { t } = useI18n();
  return (
    <div className="crash-diag-banner">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      {t("crash.diag.banner", { date: when })}
      <span className="crash-spacer" />
      <button type="button" className="crash-btn is-link" onClick={showCrashReport}>
        {t("crash.diag.backToReport")}
      </button>
    </div>
  );
}

/** Shown in the conversation where the agent attached its diagnosis to the report. */
export function DiagnosisAttachedCard() {
  const { t } = useI18n();
  return (
    <div className="crash-diag-attached" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span>{t("crash.diag.attached")}</span>
      <button type="button" className="crash-btn is-primary is-sm" onClick={showCrashReport}>
        {t("crash.diag.openReport")}
      </button>
    </div>
  );
}
