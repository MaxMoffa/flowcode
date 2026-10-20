import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import QRCode from "qrcode";
import { t, useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { SettingRow, SettingsGroup, Switch } from "./SettingsControls";
import "../dialog/modal.css";
import "./remote-access.css";
import { formatCompactDuration } from "../lib/time";
import { useSecondTick } from "../lib/useSecondTick";

interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  nodeId: string | null;
  error: string | null;
  devices: RemoteDevice[];
}

interface PairInfo {
  /** The flowcode://pair link the QR code encodes. */
  ticket: string;
  code: string;
  expiresAt: number;
}

/** Timestamps from the backend may be seconds or milliseconds; normalize. */
const toMs = (n: number) => (n < 1e12 ? n * 1000 : n);

/** "Seen ... ago" label of a device. */
function LastSeen({ at }: { at: number }) {
  useSecondTick();
  return <>{t("settings.remote.lastSeen", { time: formatCompactDuration(Date.now() - toMs(at)) })}</>;
}

/** The pairing code's countdown. */
function PairCountdown({ expiresAt }: { expiresAt: number }) {
  useSecondTick();
  return <>{t("settings.remote.pairExpires", { time: formatCompactDuration(toMs(expiresAt) - Date.now()) })}</>;
}

interface PairDialogProps {
  /** `dismissed`: the user closed it (as opposed to a phone asking to pair). */
  onClose: (dismissed: boolean) => void;
}

/** Shows a pairing QR code. The parent closes it once a new device shows up;
 * it closes itself (keeping the code valid) when a phone asks to pair, so the
 * confirmation that follows is the only thing on screen. Closing it any other
 * way invalidates the code. */
function PairDialog({ onClose }: PairDialogProps) {
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState(false);
  const [expired, setExpired] = useState(false);

  const generate = useCallback((force = false) => {
    setError(false);
    invoke<PairInfo>("remote_pair_start", { force })
      .then(setPair)
      .catch(() => {
        setPair(null);
        setError(true);
      });
  }, []);

  // No force on open: asking twice (StrictMode) must give the same code.
  useEffect(() => generate(false), [generate]);

  const dismiss = useCallback(() => {
    invoke("remote_pair_cancel").catch(() => {});
    onClose(true);
  }, [onClose]);

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen("remote://pair-request", () => onClose(false));
    return () => {
      unlisten.then((off) => off());
    };
  }, [onClose]);

  useEffect(() => {
    if (!pair) return;
    const left = toMs(pair.expiresAt) - Date.now();
    setExpired(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [pair]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  useEffect(() => {
    if (!pair) {
      setQr("");
      return;
    }
    let stale = false;
    QRCode.toString(pair.ticket, { type: "svg", margin: 1, errorCorrectionLevel: "L" })
      .then((svg) => !stale && setQr(svg))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [pair]);

  const showExpired = pair !== null && expired;

  // Portaled to <body> so no ancestor's backdrop-filter traps the fixed overlay.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="modal-panel remote-pair-panel" role="dialog" aria-modal="true" aria-label={t("settings.remote.pairTitle")}>
        <div className="remote-pair-title">{t("settings.remote.pairTitle")}</div>
        <ol className="remote-pair-steps">
          <li>{t("settings.remote.pairStep1")}</li>
          <li>{t("settings.remote.pairStep2")}</li>
        </ol>
        <div
          className={"remote-access-qr remote-pair-qr" + (showExpired ? " is-expired" : "")}
          // Generated locally by the qrcode package from the pairing link.
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        {error ? (
          <span className="settings-field-hint is-error">{t("settings.remote.pairError")}</span>
        ) : (
          pair && (
            <span className={"settings-field-hint" + (showExpired ? " is-error" : "")}>
              {showExpired ? t("settings.remote.pairExpired") : <PairCountdown expiresAt={pair.expiresAt} />}
            </span>
          )
        )}
        <div className="remote-pair-actions">
          <button type="button" className="settings-choice" onClick={() => generate(true)}>
            {t("settings.remote.pairRegenerate")}
          </button>
          <button type="button" className="settings-choice" onClick={dismiss}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The Android release matching this desktop version (a dev build counts as
 * its release): its page, and the APK's direct download link. */
function useAppRelease() {
  const [release, setRelease] = useState<{ page: string; apk: string } | null>(null);
  useEffect(() => {
    let stale = false;
    getVersion()
      .then((v) => {
        const version = v.replace(/-dev$/, "");
        const base = "https://github.com/MaxMoffa/flowcode/releases";
        if (!stale) setRelease({ page: `${base}/tag/v${version}`, apk: `${base}/download/v${version}/Flowcode-Android-${version}.apk` });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);
  return release;
}

/** The APK's download link as a QR code, for the phone's camera. */
function AppQrDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const [qr, setQr] = useState("");
  useEffect(() => {
    let stale = false;
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => !stale && setQr(svg))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [url]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel remote-pair-panel" role="dialog" aria-modal="true" aria-label={t("settings.remote.appQrTitle")}>
        <div className="remote-pair-title">{t("settings.remote.appQrTitle")}</div>
        <span className="settings-field-hint">{t("settings.remote.appQrHint")}</span>
        <div
          className="remote-access-qr remote-pair-qr"
          // Generated locally by the qrcode package from the release link.
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        <div className="remote-pair-actions">
          <button type="button" className="settings-choice" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AppDownload() {
  const release = useAppRelease();
  const [qrOpen, setQrOpen] = useState(false);
  const closeQr = useCallback(() => setQrOpen(false), []);
  return (
    <div className="remote-app-actions">
      <button type="button" className="settings-choice" disabled={!release} onClick={() => release && openUrl(release.page).catch(() => {})}>
        {t("settings.remote.appRelease")}
      </button>
      <button type="button" className="settings-choice" disabled={!release} onClick={() => setQrOpen(true)}>
        {t("settings.remote.appShowQr")}
      </button>
      {qrOpen && release && <AppQrDialog url={release.apk} onClose={closeQr} />}
    </div>
  );
}

export function RemoteAccessSettings() {
  useI18n();
  const confirm = useConfirmDialog();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const mounted = useRef(true);
  // Devices that existed when the dialog opened: one that isn't among them
  // is the phone that just scanned the code.
  const knownIds = useRef<Set<string>>(new Set());
  // Armed when the dialog opens, disarmed once a device shows up or the user
  // closes the dialog: the phone's request closes the dialog before the
  // device is actually added.
  const [watching, setWatching] = useState(false);

  const refresh = useCallback(() => {
    invoke<RemoteStatus>("remote_status")
      .then((s) => mounted.current && setStatus(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    // Polling backs up the event: "last seen" changes without one.
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    const unlisten = listen("remote://devices-changed", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      unlisten.then((off) => off());
    };
  }, [refresh]);

  const enabled = status?.enabled ?? false;

  // Turning it off invalidates any code on screen.
  useEffect(() => {
    if (!enabled) {
      setPairing(false);
      setWatching(false);
    }
  }, [enabled]);

  // A device that wasn't there when the dialog opened has paired: done.
  useEffect(() => {
    if (!watching || !status) return;
    const added = status.devices.find((d) => !knownIds.current.has(d.id));
    if (added) {
      setPairing(false);
      setWatching(false);
      setJustPaired(added.name);
    }
  }, [watching, status]);

  async function setEnabled(on: boolean) {
    try {
      setStatus(await invoke<RemoteStatus>("remote_set_enabled", { enabled: on }));
    } catch {
      refresh();
    }
  }

  function startPairing() {
    knownIds.current = new Set(status?.devices.map((d) => d.id));
    setJustPaired(null);
    setWatching(true);
    setPairing(true);
  }

  // Stable, so the dialog's listeners aren't re-registered on every render.
  const closePairing = useCallback((dismissed: boolean) => {
    setPairing(false);
    if (dismissed) setWatching(false);
  }, []);

  async function revoke(d: RemoteDevice) {
    const ok = await confirm({
      title: t("settings.remote.revokeTitle"),
      message: t("settings.remote.revokeMessage", { name: d.name }),
      confirmLabel: t("settings.remote.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      setStatus(await invoke<RemoteStatus>("remote_revoke", { deviceId: d.id }));
    } catch {
      refresh();
    }
  }

  const onOff: [string, string] = [t("settings.on"), t("settings.off")];
  let statusLine: string | null = null;
  if (enabled) {
    if (status?.error) statusLine = status.error;
    else if (status?.running) statusLine = t("settings.remote.ready");
    else statusLine = t("settings.remote.starting");
  }

  return (
    <>
    {/* The app download stands apart, above the settings: it's needed before
        there's anything to pair. */}
    <section className="settings-group">
      <div className="settings-card">
        <SettingRow id="remoteApp" label={t("settings.remote.appLabel")} desc={t("settings.remote.appDesc")} stacked>
          <AppDownload />
        </SettingRow>
      </div>
    </section>
    <SettingsGroup title={t("settings.group.phone")}>
      <SettingRow id="remoteAccess" label={t("settings.remote.label")} desc={t("settings.remote.desc")}>
        <Switch checked={enabled} onChange={setEnabled} label={t("settings.remote.label")} stateLabels={onOff} />
      </SettingRow>
      {enabled && (
        <SettingRow id="remoteDevices" label={t("settings.remote.devices")} stacked desc={statusLine}>
          <div className="remote-access">
            <div>
              <button type="button" className="settings-choice" disabled={!status?.running} onClick={startPairing}>
                {t("settings.remote.pair")}
              </button>
            </div>
            {justPaired && <span className="settings-field-hint">{t("settings.remote.paired", { name: justPaired })}</span>}
            {status && status.devices.length === 0 && (
              <span className="settings-field-hint">{t("settings.remote.noDevices")}</span>
            )}
            {status?.devices.map((d) => (
              <div key={d.id} className="remote-access-device">
                <div className="remote-access-device-text">
                  <span className="remote-access-device-name">{d.name}</span>
                  <span className="settings-field-hint">
                    {d.connected
                      ? t("settings.remote.connected")
                      : d.lastSeenAt
                        ? <LastSeen at={d.lastSeenAt} />
                        : t("settings.remote.neverSeen")}
                  </span>
                </div>
                <button type="button" className="settings-choice" onClick={() => revoke(d)}>
                  {t("settings.remote.revoke")}
                </button>
              </div>
            ))}
          </div>
        </SettingRow>
      )}
      {pairing && <PairDialog onClose={closePairing} />}
    </SettingsGroup>
    </>
  );
}
