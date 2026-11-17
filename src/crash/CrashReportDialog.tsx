import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import "../dialog/modal.css";
import "./crash-dialog.css";
import {
  causeKey,
  composeBody,
  crashIssueUrl,
  dismissAllCrashes,
  dismissCrash,
  fetchPendingCrash,
  technicalLine,
  type PendingCrash,
} from "./crashReport";

/** The backend re-checks the Windows Event Log about 20 s after start, so a
 * first empty answer is asked again once after this delay. */
const RECHECK_DELAY_MS = 30_000;

/** Shows the report of the previous run's crash, if any. The user either
 * sends it to GitHub (opened in the browser, after reviewing the text) or
 * dismisses it; both paths remove the report from the backend. */
export function CrashReportDialog() {
  const { t, language } = useI18n();
  const [pending, setPending] = useState<PendingCrash | null>(null);
  const [note, setNote] = useState("");
  const [body, setBody] = useState("");
  const [open, setOpen] = useState(false);
  const [mute, setMute] = useState(false);
  const [busy, setBusy] = useState(false);

  // Initial lookup, plus one delayed retry when nothing was found.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetchPendingCrash().catch((err: unknown) => {
        console.warn("crash_pending failed", err);
        return null;
      });
    const show = (found: PendingCrash) => {
      setPending(found);
      setBody(found.report.body);
    };
    void load().then((found) => {
      if (cancelled) return;
      if (found) {
        show(found);
        return;
      }
      timer = setTimeout(() => {
        void load().then((retry) => {
          if (!cancelled && retry) show(retry);
        });
      }, RECHECK_DELAY_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  /** "Not now": the report is discarded (shown once), plus the older ones
   * when there are any. Also used by Escape. */
  const notNow = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await dismissCrash(pending.report.id, mute);
      if (pending.otherCount > 0) await dismissAllCrashes();
    } catch (err) {
      // Failing to record the dismissal must not trap the user in the dialog.
      console.error("crash dismiss failed", err);
    }
    setBusy(false);
    setPending(null);
  }, [pending, mute, busy]);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void notNow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, notNow]);

  if (!pending) return null;

  const { report, otherCount } = pending;
  const when = new Date(report.crashedAt ?? report.startedAt).toLocaleString(language, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  /** "Report on GitHub": opens the prefilled issue, then drops the report. */
  const sendReport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await crashIssueUrl(report.title, composeBody(note, body));
      await openUrl(url);
      await dismissCrash(report.id, mute);
      // The user reported the newest crash; the older ones are dropped too.
      if (otherCount > 0) await dismissAllCrashes();
      setPending(null);
    } catch (err) {
      console.error("crash report failed", err);
      setBusy(false);
    }
  };

  return createPortal(
    // No dismiss on backdrop click: dismissing discards the report for good,
    // too costly for a stray click. Escape and "Not now" remain.
    <div className="modal-backdrop">
      <div className="modal-panel crash-dialog" role="dialog" aria-modal="true" aria-labelledby="crash-dialog-title">
        <div className="crash-main">
          <div className="crash-head">
            <div className="crash-head-ico">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
            </div>
            <div>
              <h3 id="crash-dialog-title">{t("crash.title")}</h3>
              <p>{t("crash.lead")}</p>
            </div>
          </div>

          <dl className="crash-cause">
            <dt>{t("crash.cause")}</dt>
            <dd>{t(causeKey(report))}</dd>
            <dt>{t("crash.when")}</dt>
            <dd>{t("crash.whenValue", { date: when, version: report.version })}</dd>
            <dt>{t("crash.code")}</dt>
            <dd className="crash-mono">{technicalLine(report)}</dd>
          </dl>
          {otherCount > 0 && <div className="crash-more">{t("crash.others", { count: otherCount })}</div>}

          <div className="crash-field">
            <label htmlFor="crash-note">
              {t("crash.noteLabel")} <span>{t("crash.optional")}</span>
            </label>
            <textarea id="crash-note" rows={3} placeholder={t("crash.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <button
            type="button"
            className="crash-disc"
            aria-expanded={open}
            aria-controls="crash-body"
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
            {t("crash.showDetails")}
            <span className="crash-disc-hint">{t("crash.editable")}</span>
          </button>
          {open && (
            <div className="crash-details">
              <textarea id="crash-body" className="crash-md" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          )}

          <div className="crash-privacy">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span>{t("crash.privacy")}</span>
          </div>
          <label className="crash-check">
            <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
            {t("crash.mute")}
          </label>
        </div>

        <div className="crash-foot">
          <span className="crash-spacer" />
          <button type="button" className="crash-btn is-ghost" disabled={busy} onClick={() => void notNow()}>
            {t("crash.notNow")}
          </button>
          <button type="button" className="crash-btn is-primary" disabled={busy} onClick={() => void sendReport()}>
            {t("crash.report")}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
