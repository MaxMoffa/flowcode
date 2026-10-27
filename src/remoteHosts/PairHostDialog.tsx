import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { t, useI18n } from "../i18n";
import { setActiveHost, type HostInfo } from "./remoteHosts";
import "../dialog/modal.css";
import "../settings/settings-page.css";
import "./remote-hosts.css";

const PREFIX = "flowcode://pair?t=";
/** The other PC gives up on an unanswered request after about this long. */
const EXPIRES_S = 75;
/** The system info has no computer name, so a neutral default. */
const DEFAULT_DEVICE_NAME = "Flowcode desktop";

interface Inspected {
  ticket: string;
  hostName: string;
  fingerprint: string;
}

type Stage = "paste" | "confirm" | "waiting" | "failed";

/** Pairs this desktop with another PC from its link: validate, confirm who it is, then wait for the other PC's user to accept. */
export function PairHostDialog({ onClose }: { onClose: () => void }) {
  useI18n();
  const [stage, setStage] = useState<Stage>("paste");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<Inspected | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [name, setName] = useState(DEFAULT_DEVICE_NAME);
  const [left, setLeft] = useState(EXPIRES_S);
  const cancelled = useRef(false);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  function dismiss() {
    if (stageRef.current === "waiting") {
      cancelled.current = true;
      invoke("remote_host_cancel_pair").catch(() => {});
    }
    onClose();
  }
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The countdown is only informative: the backend times the request out itself.
  useEffect(() => {
    if (stage !== "waiting") return;
    setLeft(EXPIRES_S);
    const end = Date.now() + EXPIRES_S * 1000;
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [stage]);

  async function check() {
    const ticket = link.trim();
    if (!ticket.startsWith(PREFIX)) {
      setError(t("remoteHosts.pair.invalid"));
      return;
    }
    setError(null);
    setChecking(true);
    try {
      const [info, fingerprint] = await Promise.all([
        invoke<{ hostName: string; fingerprint: string; isSelf: boolean }>("remote_host_inspect", { ticket }),
        invoke<string>("remote_host_fingerprint"),
      ]);
      if (info.isSelf) {
        setError(t("remoteHosts.pair.self"));
        return;
      }
      setFound({ ticket, hostName: info.hostName, fingerprint: info.fingerprint });
      setMine(fingerprint);
      setStage("confirm");
    } catch (e) {
      setError(typeof e === "string" ? e : t("remoteHosts.pair.invalid"));
    } finally {
      setChecking(false);
    }
  }

  async function connect() {
    if (!found) return;
    cancelled.current = false;
    setError(null);
    setStage("waiting");
    try {
      const host = await invoke<HostInfo>("remote_host_pair", { ticket: found.ticket, deviceName: name.trim() || DEFAULT_DEVICE_NAME });
      setActiveHost(host.id);
      onClose();
    } catch (e) {
      if (cancelled.current) return;
      setError(typeof e === "string" ? e : t("remoteHosts.pair.refused"));
      setStage("failed");
    }
  }

  // Portaled to <body> so no ancestor's backdrop-filter traps the fixed overlay.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && stage !== "waiting") dismiss();
      }}
    >
      <div className="modal-panel host-pair-panel" role="dialog" aria-modal="true" aria-label={t("remoteHosts.pair.title")}>
        {stage === "paste" && (
          <form
            className="host-pair-form"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <div className="host-pair-title">{t("remoteHosts.pair.title")}</div>
            <span className="settings-field-hint">{t("remoteHosts.pair.hint")}</span>
            <textarea
              className="settings-text-input host-pair-link"
              value={link}
              autoFocus
              rows={3}
              spellCheck={false}
              placeholder="flowcode://pair?t=..."
              aria-label={t("remoteHosts.pair.linkLabel")}
              onChange={(e) => setLink(e.target.value)}
            />
            {error && (
              <span className="settings-field-hint is-error" role="alert">
                {error}
              </span>
            )}
            <div className="host-pair-actions">
              <button type="button" className="settings-choice" onClick={dismiss}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="settings-choice is-primary" disabled={!link.trim() || checking}>
                {t("remoteHosts.pair.next")}
              </button>
            </div>
          </form>
        )}

        {stage === "confirm" && found && (
          <div className="host-pair-form">
            <div className="host-pair-title">{t("remoteHosts.pair.confirmTitle", { host: found.hostName })}</div>
            <div className="host-pair-codes">
              <div>
                <small>{t("remoteHosts.pair.theirCode", { host: found.hostName })}</small>
                <b className="host-pair-code">{found.fingerprint}</b>
              </div>
              <div>
                <small>{t("remoteHosts.pair.myCode")}</small>
                <b className="host-pair-code">{mine ?? "…"}</b>
              </div>
            </div>
            <span className="settings-field-hint">{t("remoteHosts.pair.codeHint", { host: found.hostName })}</span>
            <label className="host-pair-field">
              <span>{t("remoteHosts.pair.deviceName")}</span>
              <input className="settings-text-input" value={name} maxLength={40} spellCheck={false} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="host-pair-actions">
              <button type="button" className="settings-choice" onClick={() => setStage("paste")}>
                {t("common.cancel")}
              </button>
              <button type="button" className="settings-choice is-primary" onClick={() => void connect()}>
                {t("remoteHosts.pair.connect")}
              </button>
            </div>
          </div>
        )}

        {stage === "waiting" && found && (
          <div className="host-pair-form" role="status">
            <div className="host-pair-title">{t("remoteHosts.pair.waitTitle", { host: found.hostName })}</div>
            {mine && <b className="host-pair-code">{mine}</b>}
            <span className="settings-field-hint">{t("remoteHosts.pair.waitBody", { host: found.hostName })}</span>
            <div className="host-pair-wait">
              <span className="host-spinner" aria-hidden="true" />
              <span>{t("remoteHosts.pair.expires", { s: left })}</span>
            </div>
            <div className="host-pair-actions">
              <button type="button" className="settings-choice" onClick={dismiss}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        {stage === "failed" && (
          <div className="host-pair-form" role="alert">
            <div className="host-pair-title">{t("remoteHosts.pair.failedTitle")}</div>
            <span className="settings-field-hint is-error">{error ?? t("remoteHosts.pair.refused")}</span>
            <div className="host-pair-actions">
              <button type="button" className="settings-choice" onClick={dismiss}>
                {t("common.close")}
              </button>
              <button type="button" className="settings-choice is-primary" onClick={() => setStage("confirm")}>
                {t("remoteHosts.pair.retry")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
