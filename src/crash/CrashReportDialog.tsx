import { useExitGhost } from "../hooks/useExitGhost";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { useI18n, type MessageKey } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import "../dialog/modal.css";
import "./crash-dialog.css";
import "./crash-diagnosis.css";
import {
  causeKey,
  composeBody,
  confidenceKey,
  crashIssueUrl,
  diagnosisPrompt,
  dismissAllCrashes,
  dismissCrash,
  fetchPendingCrash,
  issueUrl,
  technicalLine,
  verdictKind,
  type Diagnosis,
  type PendingCrash,
} from "./crashReport";
import {
  closeDiagnosisChat,
  defaultDiagnosisAgent,
  focusDiagnosisChat,
  lastDiagnosisAgent,
  openDiagnosisChat,
  rememberDiagnosisAgent,
  useDiagnosisAgents,
  useDiagnosisEvent,
  type DiagnosisAgent,
  type DiagnosisChatReport,
} from "./diagnosis";

/** The backend re-checks the Windows Event Log about 20 s after start, so a
 * first empty answer is asked again once after this delay. */
const RECHECK_DELAY_MS = 30_000;

/** Where the agent's analysis of the crash stands. `worked`: the chat has had a turn, so going idle again means it is over. */
type Analysis = { kind: "idle" } | { kind: "analyzing"; agent: AgentCli; worked: boolean } | { kind: "noResult"; agent: AgentCli };

/** The language's English name, for the prompt's "answer in ...". */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function AgentIcon({ cli }: { cli: string }) {
  return <span className="crash-agent-ico" aria-hidden="true">{agentCliIcon(cli)}</span>;
}

/** The agent's conclusion, above the cause card. */
function VerdictCard({ diagnosis }: { diagnosis: Diagnosis }) {
  const { t } = useI18n();
  const kind = verdictKind(diagnosis);
  const percent = Math.round(diagnosis.confidence * 100);
  const bullets = kind === "machine" ? diagnosis.localFix : [];
  return (
    <div className={`crash-verdict is-${kind}`}>
      <div className="crash-verdict-head">
        <span className="crash-verdict-badge">{t(`crash.diag.badge.${kind}` as MessageKey, { n: diagnosis.existingIssue ?? "" })}</span>
        <span className="crash-verdict-title">{diagnosis.title}</span>
        <span className="crash-verdict-by">
          <AgentIcon cli={diagnosis.agent} />
          {cliName(diagnosis.agent)}
        </span>
      </div>
      <div className="crash-verdict-conf">
        <div className="crash-verdict-meter" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
        {t(confidenceKey(diagnosis.confidence))} <span>· {percent}%</span>
      </div>
      <p>{diagnosis.summary}</p>
      {bullets.length > 0 && (
        <ul>
          {bullets.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ul>
      )}
      {(kind === "bug" || kind === "unknown") && (diagnosis.evidence.length > 0 || diagnosis.reproSteps.length > 0) && <div className="crash-verdict-hint">{t("crash.diag.bugNote")}</div>}
      {kind === "dup" && <div className="crash-verdict-hint">{t("crash.diag.dupHint")}</div>}
    </div>
  );
}

/** "Analizza con <agent>" with the menu of the six agents. */
function AnalyzeSplit({ agents, analysis, onPick }: { agents: DiagnosisAgent[]; analysis: Analysis; onPick: (cli: AgentCli) => void }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const last = lastDiagnosisAgent();
  const main = defaultDiagnosisAgent(agents, last);

  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The menu closes first; the dialog's own Escape must not also dismiss the report.
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [menu]);

  if (!main) return null;
  if (analysis.kind === "analyzing") {
    return (
      <div className="crash-split">
        <button type="button" className="crash-btn is-main" disabled>
          <span className="crash-spin" aria-hidden="true" />
          {t("crash.diag.running")}
        </button>
      </div>
    );
  }
  return (
    <div className="crash-split" ref={ref}>
      <button type="button" className="crash-btn is-main" onClick={() => onPick(main)}>
        <AgentIcon cli={main} />
        {t("crash.diag.analyzeWith", { agent: cliName(main) })}
      </button>
      <button type="button" className="crash-btn is-chev" aria-haspopup="menu" aria-expanded={menu} aria-label={t("crash.diag.pick")} onClick={() => setMenu((v) => !v)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu && (
        <div className="crash-menu" role="menu">
          <div className="crash-menu-head">{t("crash.diag.menuTitle")}</div>
          {agents.map((a) => (
            <button
              key={a.cli}
              type="button"
              role="menuitem"
              className={`crash-menu-item${a.cli === main ? " is-selected" : ""}`}
              disabled={!a.ready}
              onClick={() => {
                setMenu(false);
                onPick(a.cli);
              }}
            >
              <AgentIcon cli={a.cli} />
              {cliName(a.cli)}
              {a.reason ? <small>{t(a.reason === "notInstalled" ? "crash.diag.notInstalled" : "crash.diag.notSignedIn")}</small> : a.cli === last ? <small>{t("crash.diag.lastUsed")}</small> : null}
            </button>
          ))}
          <div className="crash-menu-note">{t("crash.diag.note")}</div>
        </div>
      )}
    </div>
  );
}

/** Shows the report of the previous run's crash, if any. The user either
 * sends it to GitHub (opened in the browser, after reviewing the text) or
 * dismisses it; both paths remove the report from the backend. Before that
 * an agent can investigate it (see diagnosis.ts): the dialog gives way to a
 * pill while it works and comes back with its verdict. */
export function CrashReportDialog() {
  const exitRef = useExitGhost<HTMLDivElement>();
  const { t, language } = useI18n();
  const [pending, setPending] = useState<PendingCrash | null>(null);
  const [note, setNote] = useState("");
  const [body, setBody] = useState("");
  const [open, setOpen] = useState(false);
  const [mute, setMute] = useState(false);
  const [busy, setBusy] = useState(false);
  // The dialog is out of the way (the pill shows instead): an analysis is running, or the user went to read the chat.
  const [parked, setParked] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis>({ kind: "idle" });
  // The diagnosis chat's tab is open, so the report can link to it.
  const [chatOpen, setChatOpen] = useState(false);
  const agents = useDiagnosisAgents();
  const pendingId = pending?.report.id;
  const pendingIdRef = useRef(pendingId);
  pendingIdRef.current = pendingId;

  const show = useCallback((found: PendingCrash) => {
    setPending(found);
    setBody(found.report.body);
  }, []);

  // Initial lookup, plus one delayed retry when nothing was found.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetchPendingCrash().catch((err: unknown) => {
        console.warn("crash_pending failed", err);
        return null;
      });
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
  }, [show]);

  // The agent attached its diagnosis: the report is read again (the backend put the diagnosis in it) and comes back.
  useEffect(() => {
    let live = true;
    const unlisten = listen<{ reportId: string }>("crash-diagnosis", (e) => {
      if (e.payload.reportId !== pendingIdRef.current) return;
      setAnalysis({ kind: "idle" });
      void fetchPendingCrash().then(
        (found) => {
          if (!live || !found || found.report.id !== e.payload.reportId) return;
          show(found);
          setParked(false);
        },
        (err: unknown) => console.warn("crash_pending failed", err),
      );
    });
    return () => {
      live = false;
      void unlisten.then((off) => off());
    };
  }, [show]);

  // The diagnosis chat's progress: once it has worked and is idle again (or gone) without a diagnosis, there is none coming.
  useDiagnosisEvent<DiagnosisChatReport>("chat", ({ reportId, status }) => {
    if (reportId !== pendingIdRef.current) return;
    if (status === "closed") setChatOpen(false);
    setAnalysis((a) => {
      if (a.kind !== "analyzing") return a;
      if (status === "busy" || status === "waiting") return a.worked ? a : { ...a, worked: true };
      if (status === "closed" || status === "exited" || (status === "idle" && a.worked)) return { kind: "noResult", agent: a.agent };
      return a;
    });
  });

  /** Brings the report back (also from the diagnosis chat); a late diagnosis is picked up too. */
  const showReport = useCallback(() => {
    setParked(false);
    void fetchPendingCrash().then(
      (found) => {
        if (found && found.report.id === pendingIdRef.current && found.diagnosis) show(found);
      },
      () => {},
    );
    setAnalysis((a) => (a.kind === "noResult" ? { kind: "idle" } : a));
  }, [show]);
  useDiagnosisEvent<undefined>("show", showReport);

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
    setAnalysis({ kind: "idle" });
  }, [pending, mute, busy]);

  const visible = !!pending && !parked;
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      void notNow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, notNow]);

  if (!pending) return null;

  const { report, otherCount, diagnosis } = pending;
  const when = new Date(report.crashedAt ?? report.startedAt).toLocaleString(language, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  /** Drops the report once it was acted on (the older ones too: the newest crash was the one reported). */
  const finish = async () => {
    await dismissCrash(report.id, mute);
    if (otherCount > 0) await dismissAllCrashes();
    setPending(null);
    setAnalysis({ kind: "idle" });
  };

  /** "Report on GitHub": opens the prefilled issue, then drops the report. */
  const sendReport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await crashIssueUrl(report.title, composeBody(note, body));
      await openUrl(url);
      await finish();
    } catch (err) {
      console.error("crash report failed", err);
      setBusy(false);
    }
  };

  /** "Comment on #N": the comment (diagnosis, system and error sections) goes to the clipboard, the issue opens. */
  const commentOnIssue = async (number: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(composeBody(note, body));
      await openUrl(issueUrl(number));
      await finish();
    } catch (err) {
      console.error("crash comment failed", err);
      setBusy(false);
    }
  };

  /** Starts the diagnosis chat; the dialog gives way to the pill. */
  const analyze = (cli: AgentCli) => {
    if (analysis.kind === "analyzing") return;
    rememberDiagnosisAgent(cli);
    setAnalysis({ kind: "analyzing", agent: cli, worked: false });
    setParked(true);
    openDiagnosisChat({
      agent: cli,
      cwd: pending.dir,
      reportId: report.id,
      when,
      label: t("crash.diag.tab"),
      prompt: diagnosisPrompt(pending, languageName(language)),
      opened: (ok) => {
        setChatOpen(ok);
        if (ok) return;
        // The agent could not be started (not installed, sign-in cancelled): back to the report.
        setAnalysis({ kind: "idle" });
        setParked(false);
      },
    });
  };

  /** The pill's cross: the analysis is given up and the chat closed. */
  const cancelAnalysis = () => {
    closeDiagnosisChat(report.id);
    setChatOpen(false);
    setAnalysis({ kind: "idle" });
    setParked(false);
  };

  const kind = diagnosis ? verdictKind(diagnosis) : null;
  const muteBox = (
    <label className="crash-check">
      <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
      {t("crash.mute")}
    </label>
  );
  const externalIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
  const openChatLink =
    chatOpen && diagnosis ? (
      <button
        type="button"
        className="crash-btn is-link"
        onClick={() => {
          focusDiagnosisChat(report.id);
          setParked(true);
        }}
      >
        {t("crash.diag.openChat")}
      </button>
    ) : null;

  let footer;
  if (kind === "machine") {
    footer = (
      <>
        {muteBox}
        <span className="crash-spacer" />
        <button type="button" className="crash-btn is-ghost" disabled={busy} onClick={() => void sendReport()}>
          {t("crash.diag.reportAnyway")}
        </button>
        <button type="button" className="crash-btn is-primary" disabled={busy} onClick={() => void notNow()}>
          {t("crash.diag.understood")}
        </button>
      </>
    );
  } else if (kind === "dup" && diagnosis?.existingIssue != null) {
    const number = diagnosis.existingIssue;
    footer = (
      <>
        <button type="button" className="crash-btn is-link" onClick={() => void openUrl(issueUrl(number))}>
          {t("crash.diag.seeIssue", { n: number })}
        </button>
        <span className="crash-spacer" />
        <button type="button" className="crash-btn is-ghost" disabled={busy} onClick={() => void notNow()}>
          {t("crash.notNow")}
        </button>
        <button type="button" className="crash-btn is-primary" disabled={busy} onClick={() => void commentOnIssue(number)}>
          {t("crash.diag.commentOn", { n: number })}
          {externalIcon}
        </button>
      </>
    );
  } else if (kind) {
    footer = (
      <>
        {openChatLink}
        <span className="crash-spacer" />
        <button type="button" className="crash-btn is-ghost" disabled={busy} onClick={() => void notNow()}>
          {t("crash.notNow")}
        </button>
        <button type="button" className="crash-btn is-primary" disabled={busy} onClick={() => void sendReport()}>
          {t("crash.diag.reportWith")}
          {externalIcon}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        {agents && <AnalyzeSplit agents={agents} analysis={analysis} onPick={analyze} />}
        <span className="crash-spacer" />
        <button type="button" className="crash-btn is-ghost" disabled={busy} onClick={() => void notNow()}>
          {t("crash.notNow")}
        </button>
        <button type="button" className="crash-btn is-primary" disabled={busy} onClick={() => void sendReport()}>
          {t("crash.report")}
          {externalIcon}
        </button>
      </>
    );
  }

  const pill = parked && (
    <div className="crash-pill" role="status">
      {analysis.kind === "analyzing" && <div className="crash-spin" aria-hidden="true" />}
      <div className="crash-pill-text">
        <b>{analysis.kind === "analyzing" ? t("crash.diag.pill.title", { agent: cliName(analysis.agent) }) : analysis.kind === "noResult" ? t("crash.diag.pill.noResult") : t("crash.diag.pill.parked")}</b>
        <span>{analysis.kind === "analyzing" ? t("crash.diag.pill.sub") : analysis.kind === "noResult" ? t("crash.diag.pill.noResultSub") : t("crash.diag.pill.parkedSub")}</span>
      </div>
      {analysis.kind === "analyzing" ? (
        <>
          <button type="button" className="crash-btn is-ghost is-sm" onClick={() => focusDiagnosisChat(report.id)}>
            {t("crash.diag.pill.open")}
          </button>
          <button type="button" className="crash-btn is-icon is-sm" title={t("crash.diag.pill.cancel")} aria-label={t("crash.diag.pill.cancel")} onClick={cancelAnalysis}>
            ✕
          </button>
        </>
      ) : (
        <button type="button" className="crash-btn is-ghost is-sm" onClick={showReport}>
          {t("crash.diag.pill.openReport")}
        </button>
      )}
    </div>
  );

  return createPortal(
    <>
      {pill}
      {visible && (
        // No dismiss on backdrop click: dismissing discards the report for good,
        // too costly for a stray click. Escape and "Not now" remain.
        <div className="modal-backdrop" ref={exitRef}>
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

              {diagnosis && <VerdictCard diagnosis={diagnosis} />}

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
              {kind !== "machine" && muteBox}
            </div>

            <div className="crash-foot">{footer}</div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
