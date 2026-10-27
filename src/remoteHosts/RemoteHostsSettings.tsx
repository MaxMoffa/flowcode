import { useState } from "react";
import { t, useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { SettingRow, SettingsGroup } from "../settings/SettingsControls";
import { StatusDot, statusLabel } from "./HostSelector";
import { PairHostDialog } from "./PairHostDialog";
import { connectHost, disconnectHost, forgetHost, useHosts } from "./remoteHosts";
import "./remote-hosts.css";

/** The PCs this desktop connects to (the reverse of the phone list above it). */
export function RemoteHostsSettings() {
  useI18n();
  const confirm = useConfirmDialog();
  const hosts = useHosts();
  const [pairing, setPairing] = useState(false);

  async function remove(id: string, name: string) {
    const ok = await confirm({
      title: t("remoteHosts.forgetTitle"),
      message: t("remoteHosts.forgetMessage", { name }),
      confirmLabel: t("remoteHosts.forget"),
      danger: true,
    });
    if (ok) void forgetHost(id);
  }

  return (
    <SettingsGroup title={t("remoteHosts.group")}>
      <SettingRow id="remoteHosts" label={t("remoteHosts.label")} desc={t("remoteHosts.desc")} stacked>
        <div className="remote-access">
          <div>
            <button type="button" className="settings-choice" onClick={() => setPairing(true)}>
              {t("remoteHosts.connectAnother")}
            </button>
          </div>
          {hosts.length === 0 && <span className="settings-field-hint">{t("remoteHosts.none")}</span>}
          {hosts.map((h) => (
            <div key={h.id} className="remote-access-device">
              <div className="remote-access-device-text">
                <span className="remote-access-device-name host-settings-name">
                  <StatusDot host={h} />
                  {h.hostName}
                </span>
                <span className="settings-field-hint">
                  {statusLabel(h)}
                  {h.appVersion ? ` · v${h.appVersion}` : ""}
                  {h.error ? ` · ${h.error}` : ""}
                </span>
              </div>
              <div className="host-settings-actions">
                {h.status === "offline" ? (
                  <button type="button" className="settings-choice" onClick={() => void connectHost(h.id)}>
                    {t("remoteHosts.connect")}
                  </button>
                ) : (
                  <button type="button" className="settings-choice" onClick={() => void disconnectHost(h.id)}>
                    {t("remoteHosts.disconnect")}
                  </button>
                )}
                <button type="button" className="settings-choice is-danger" onClick={() => void remove(h.id, h.hostName)}>
                  {t("remoteHosts.forget")}
                </button>
              </div>
            </div>
          ))}
        </div>
        {pairing && <PairHostDialog onClose={() => setPairing(false)} />}
      </SettingRow>
    </SettingsGroup>
  );
}
