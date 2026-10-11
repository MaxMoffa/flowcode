import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { t, useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { SettingRow, SettingsGroup, Switch } from "./SettingsControls";
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
  address: string | null;
  url: string | null;
  error: string | null;
  devices: RemoteDevice[];
}

interface PairInfo {
  url: string;
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

export function RemoteAccessSettings() {
  useI18n();
  const confirm = useConfirmDialog();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [qr, setQr] = useState("");
  const [pairError, setPairError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

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

  useEffect(() => {
    if (!pair) {
      setQr("");
      return;
    }
    let stale = false;
    QRCode.toString(pair.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => !stale && setQr(svg))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [pair]);

  const enabled = status?.enabled ?? false;

  // Turning it off invalidates any code on screen.
  useEffect(() => {
    if (!enabled) setPair(null);
  }, [enabled]);

  async function setEnabled(on: boolean) {
    try {
      setStatus(await invoke<RemoteStatus>("remote_set_enabled", { enabled: on }));
    } catch {
      refresh();
    }
  }

  async function startPairing() {
    setPairError(false);
    try {
      setPair(await invoke<PairInfo>("remote_pair_start"));
    } catch {
      setPair(null);
      setPairError(true);
    }
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
  const remaining = pair ? toMs(pair.expiresAt) - now : 0;
  let statusLine: string | null = null;
  if (enabled) {
    if (status?.error) statusLine = status.error;
    else if (status?.running && status.address) statusLine = t("settings.remote.address", { address: status.address });
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
                {pair ? t("settings.remote.pairRegenerate") : t("settings.remote.pair")}
              </button>
            </div>
            {pairError && <span className="settings-field-hint is-error">{t("settings.remote.pairError")}</span>}
            {pair && (
              <div className="remote-access-pair">
                <div
                  className={"remote-access-qr" + (remaining <= 0 ? " is-expired" : "")}
                  // Generated locally by the qrcode package from the URL.
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
                <div className="remote-access-pair-text">
                  <span className="settings-field-hint">{t("settings.remote.pairHint")}</span>
                  <code className="remote-access-url">{pair.url}</code>
                  <span className={"settings-field-hint" + (remaining <= 0 ? " is-error" : "")}>
                    {remaining > 0
                      ? t("settings.remote.pairExpires", { time: formatDuration(remaining) })
                      : t("settings.remote.pairExpired")}
                  </span>
                </div>
              </div>
            )}
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
    </SettingsGroup>
  );
}
