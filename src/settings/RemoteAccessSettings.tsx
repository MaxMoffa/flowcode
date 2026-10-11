import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { t, useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { SettingRow, SettingsGroup, Switch } from "./SettingsControls";
import "../dialog/modal.css";
import "./remote-access.css";

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

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface PairDialogProps {
  onClose: () => void;
}

/** Shows a pairing QR code. The parent closes it once a new device shows up. */
function PairDialog({ onClose }: PairDialogProps) {
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const generate = useCallback(() => {
    setError(false);
    invoke<PairInfo>("remote_pair_start")
      .then(setPair)
      .catch(() => {
        setPair(null);
        setError(true);
      });
  }, []);

  useEffect(generate, [generate]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const remaining = pair ? toMs(pair.expiresAt) - now : 0;
  const expired = pair !== null && remaining <= 0;

  // Portaled to <body> so no ancestor's backdrop-filter traps the fixed overlay.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel remote-pair-panel" role="dialog" aria-modal="true" aria-label={t("settings.remote.pairTitle")}>
        <div className="remote-pair-title">{t("settings.remote.pairTitle")}</div>
        <ol className="remote-pair-steps">
          <li>{t("settings.remote.pairStep1")}</li>
          <li>{t("settings.remote.pairStep2")}</li>
        </ol>
        <div
          className={"remote-access-qr remote-pair-qr" + (expired ? " is-expired" : "")}
          // Generated locally by the qrcode package from the pairing link.
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        {error ? (
          <span className="settings-field-hint is-error">{t("settings.remote.pairError")}</span>
        ) : (
          pair && (
            <span className={"settings-field-hint" + (expired ? " is-error" : "")}>
              {expired
                ? t("settings.remote.pairExpired")
                : t("settings.remote.pairExpires", { time: formatDuration(remaining) })}
            </span>
          )
        )}
        <div className="remote-pair-actions">
          <button type="button" className="settings-choice" onClick={generate}>
            {t("settings.remote.pairRegenerate")}
          </button>
          <button type="button" className="settings-choice" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function RemoteAccessSettings() {
  useI18n();
  const confirm = useConfirmDialog();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  // Devices that existed when the dialog opened: one that isn't among them
  // is the phone that just scanned the code.
  const knownIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    invoke<RemoteStatus>("remote_status")
      .then((s) => mounted.current && setStatus(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    // Polling backs up the event: "last seen" changes without one.
    const timer = setInterval(refresh, 5000);
    const unlisten = listen("remote://devices-changed", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      unlisten.then((off) => off());
    };
  }, [refresh]);

  // Drives the pairing countdown and the "seen ... ago" labels.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const enabled = status?.enabled ?? false;

  // Turning it off invalidates any code on screen.
  useEffect(() => {
    if (!enabled) setPairing(false);
  }, [enabled]);

  // A device that wasn't there when the dialog opened has paired: done.
  useEffect(() => {
    if (!pairing || !status) return;
    const added = status.devices.find((d) => !knownIds.current.has(d.id));
    if (added) {
      setPairing(false);
      setJustPaired(added.name);
    }
  }, [pairing, status]);

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
    setPairing(true);
  }

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
    <SettingsGroup title={t("settings.group.remote")}>
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
                        ? t("settings.remote.lastSeen", { time: formatDuration(now - toMs(d.lastSeenAt)) })
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
      {pairing && <PairDialog onClose={() => setPairing(false)} />}
    </SettingsGroup>
  );
}
