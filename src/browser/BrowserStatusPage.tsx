// The in-app browser's own pages: the new tab, and the stand-ins for a native view that could not load (server
// down, no network, certificate, blocked address, crashed page). A doodle, a sentence, the actions, and a
// "Technical details" dialog from which an agent can be asked to investigate.
import { useEffect, useRef, useState } from "react";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { useI18n, type MessageKey } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import { defaultDiagnosisAgent, lastDiagnosisAgent, rememberDiagnosisAgent, useDiagnosisAgents } from "../crash/diagnosis";
import type { BrowserState, PageError } from "./browserStore";
import { ErrorArt } from "./errorArt";
import { nativeView } from "./nativeView";
import { codeMeaning, detailLines, detailsText, hostOfUrl, portOfUrl, statusPageFor, type StatusPageId } from "./statusPageModel";
import "./browser-status.css";

/** How often a dead local server is asked whether it is back. */
const PROBE_MS = 2000;

type ActionId = "retry" | "reload" | "openTerminal" | "external" | "back" | "devtools";

interface Content {
  title: MessageKey;
  text: MessageKey;
  actions: { id: ActionId; label: MessageKey; primary?: boolean }[];
}

const CONTENT: Record<StatusPageId | "other", Content> = {
  newtab: { title: "browser.page.newtab.title", text: "browser.page.newtab.text", actions: [] },
  local: {
    title: "browser.page.local.title",
    text: "browser.page.local.text",
    actions: [
      { id: "retry", label: "browser.page.retry", primary: true },
      { id: "openTerminal", label: "browser.page.openTerminal" },
    ],
  },
  offline: {
    title: "browser.page.offline.title",
    text: "browser.page.offline.text",
    actions: [
      { id: "retry", label: "browser.page.retry", primary: true },
      { id: "external", label: "browser.openExternal" },
    ],
  },
  other: {
    title: "browser.page.other.title",
    text: "browser.page.other.text",
    actions: [
      { id: "retry", label: "browser.page.retry", primary: true },
      { id: "external", label: "browser.openExternal" },
    ],
  },
  timeout: {
    title: "browser.page.timeout.title",
    text: "browser.page.timeout.text",
    actions: [
      { id: "retry", label: "browser.page.retry", primary: true },
      { id: "external", label: "browser.openExternal" },
    ],
  },
  cert: {
    title: "browser.page.cert.title",
    text: "browser.page.cert.text",
    actions: [
      { id: "external", label: "browser.openExternal" },
      { id: "back", label: "browser.back" },
    ],
  },
  blocked: { title: "browser.page.blocked.title", text: "browser.page.blocked.text", actions: [{ id: "back", label: "browser.back", primary: true }] },
  crash: {
    title: "browser.page.crash.title",
    text: "browser.page.crash.text",
    actions: [
      { id: "reload", label: "browser.page.reload", primary: true },
      { id: "devtools", label: "browser.menu.devtools" },
    ],
  },
};

export interface BrowserStatusPageProps {
  /** The failed page's error (with the page's id and retry state); null on the new tab page. */
  failure: { pageId: string; error: PageError; retrying: boolean } | null;
  servers: BrowserState["servers"];
  onReload: () => void;
  onBack: () => void;
  onOpenExternal: () => void;
  onOpenTerminal: () => void;
  onOpenUrl: (url: string) => void;
  /** The agent was picked in the dialog: open its chat with `prompt` sent. */
  onDiagnose: (agent: AgentCli, prompt: string, host: string) => void;
}

function AgentMenu({ prompt, onPick }: { prompt: string; onPick: (cli: AgentCli) => void }) {
  const { t } = useI18n();
  const agents = useDiagnosisAgents();
  const last = lastDiagnosisAgent();
  const main = agents ? defaultDiagnosisAgent(agents, last) : null;
  return (
    <div className="bsp-agent-pop" role="menu">
      <div className="bsp-agent-head">{t("browser.page.agent.head")}</div>
      {(agents ?? []).map((a) => (
        <button
          key={a.cli}
          type="button"
          role="menuitem"
          className={"bsp-agent-row" + (a.cli === main ? " is-selected" : "")}
          disabled={!a.ready}
          onClick={() => onPick(a.cli)}
        >
          <span className="bsp-agent-ico" aria-hidden="true">{agentCliIcon(a.cli)}</span>
          {cliName(a.cli)}
          {a.reason ? <small>{t(a.reason === "notInstalled" ? "crash.diag.notInstalled" : "crash.diag.notSignedIn")}</small> : a.cli === last ? <small>{t("crash.diag.lastUsed")}</small> : null}
        </button>
      ))}
      <div className="bsp-agent-note">{t("browser.page.agent.note")}</div>
      <pre className="bsp-agent-prompt">{prompt}</pre>
    </div>
  );
}

export function BrowserStatusPage({ failure, servers, onReload, onBack, onOpenExternal, onOpenTerminal, onOpenUrl, onDiagnose }: BrowserStatusPageProps) {
  const { t, language } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const error = failure?.error ?? null;
  const pageId: StatusPageId = error ? statusPageFor(error) : "newtab";
  const content = CONTENT[error?.kind === "other" ? "other" : pageId];
  const host = error ? hostOfUrl(error.url) : "";
  const port = error ? portOfUrl(error.url) : "";
  const retrying = !!failure?.retrying;
  const alive = servers.filter((s) => s.alive);

  // A dead local server: ask the port every 2 s and reload by itself when it answers.
  const errorUrl = pageId === "local" ? error?.url : undefined;
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  const retryingRef = useRef(retrying);
  retryingRef.current = retrying;
  useEffect(() => {
    if (!errorUrl) return;
    let stale = false;
    const timer = setInterval(() => {
      if (retryingRef.current) return;
      nativeView.probeLocal(errorUrl).then(
        (up) => {
          if (up && !stale) reloadRef.current();
        },
        () => {},
      );
    }, PROBE_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [errorUrl]);

  // Escape closes the agent menu first, then the dialog.
  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape also closes the panel when it is an overlay: this one is for the dialog only.
      e.stopPropagation();
      if (menuOpen) setMenuOpen(false);
      else setDetailsOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [detailsOpen, menuOpen]);

  const kindLabel = error ? t(`browser.page.kind.${error.kind}` as MessageKey) : "";
  const code = error?.code ?? "about:blank";
  const lines = detailLines(pageId, error, alive, language).map((l) => ({ label: t(l.label), value: l.value }));
  const urlText = error?.url ?? t("browser.page.newtab.label");
  const meaning = error ? codeMeaning(error.code) : null;
  const meaningRow = meaning ? [{ label: t("browser.page.detail.meaning"), value: t(meaning.key, { http: meaning.http ?? "" }) }] : [];
  const detailRows = error ? [{ label: t("browser.page.detail.kind"), value: kindLabel }, { label: t("browser.page.detail.code"), value: error.code }, ...meaningRow, { label: t("browser.page.detail.address"), value: error.url }, ...lines] : lines;
  const prompt = error
    ? t("browser.page.prompt", { url: error.url, kind: error.kind, code: error.code, details: lines.map((l) => `${l.label}: ${l.value}`).join("\n") })
    : "";

  const run = (id: ActionId) => {
    if (id === "retry" || id === "reload") onReload();
    else if (id === "openTerminal") onOpenTerminal();
    else if (id === "external") onOpenExternal();
    else if (id === "back") onBack();
    else if (failure) void nativeView.devtools(failure.pageId).catch(() => {});
  };

  const tone = pageId === "newtab" ? "is-ok" : pageId === "local" || pageId === "timeout" ? "is-wait" : "is-bad";
  const copy = () => {
    void navigator.clipboard.writeText(detailsText(code, urlText, "", detailRows.map((r) => ({ label: r.label, value: r.value })))).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="bsp">
      <div className="bsp-main">
        <div className="bsp-art"><ErrorArt id={pageId} /></div>
        <h4>{t(content.title, { host, port })}</h4>
        <p>{t(content.text, { host, port })}</p>
        {content.actions.length > 0 && (
          <div className="bsp-actions">
            {content.actions.map((a) => {
              const spin = retrying && (a.id === "retry" || a.id === "reload");
              return (
                <button key={a.id} type="button" className={"browser-panel-btn" + (a.primary ? " is-primary" : "")} disabled={spin} onClick={() => run(a.id)}>
                  {spin ? <span className="bsp-spin" aria-hidden="true" /> : a.id === "retry" || a.id === "reload" ? "↻" : null}
                  {t(a.label)}
                </button>
              );
            })}
          </div>
        )}
        {pageId === "local" && (
          <div className="bsp-live">
            <i />
            {t("browser.page.local.waiting")}
          </div>
        )}
        {pageId === "newtab" && alive.length > 0 && (
          <div className="bsp-tiles">
            {alive.map((s) => (
              <button key={s.port} type="button" className="bsp-tile" onClick={() => onOpenUrl(s.url)} title={s.url}>
                {`localhost:${s.port}`}
                <small>{t("browser.tabs.serverAlive")}</small>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="bsp-more" onClick={() => setDetailsOpen(true)}>
          {t("browser.page.details")}
        </button>
      </div>

      {detailsOpen && (
        <div
          className="bsp-scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDetailsOpen(false);
          }}
        >
          <div className="bsp-dlg" role="dialog" aria-label={t("browser.page.details")}>
            <header>
              {t("browser.page.details")}
              <button type="button" className="bsp-x" onClick={() => setDetailsOpen(false)} aria-label={t("common.close")}>
                ✕
              </button>
            </header>
            <div className="bsp-bar">
              <b className={tone}>●</b>
              {code}
              <span>{urlText}</span>
            </div>
            {detailRows.length > 0 && (
              <dl className="bsp-rows">
                {detailRows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <footer>
              <button type="button" className="browser-panel-btn" onClick={copy}>
                {copied ? t("common.copied") : t("browser.page.copy")}
              </button>
              {error && (
                <span className="bsp-agent-wrap">
                  <button type="button" className="browser-panel-btn bsp-agent-btn" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                    {`✦ ${t("browser.page.agent.ask")}`}
                  </button>
                  {menuOpen && (
                    <AgentMenu
                      prompt={prompt}
                      onPick={(cli) => {
                        rememberDiagnosisAgent(cli);
                        setMenuOpen(false);
                        setDetailsOpen(false);
                        onDiagnose(cli, prompt, host);
                      }}
                    />
                  )}
                </span>
              )}
              <button type="button" className="browser-panel-btn is-primary" onClick={() => setDetailsOpen(false)}>
                {t("common.close")}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
