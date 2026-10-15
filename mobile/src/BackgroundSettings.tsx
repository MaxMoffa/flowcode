import { useEffect, useState } from "react";
import { t } from "./i18n";
import { notificationPermission, requestNotificationPermission, setBackgroundSettings, useSupports, type BackgroundSettings } from "./remote";
import { Group, Segmented, Toggle } from "./SettingsControls";

const CAPS: { id: string; minutes: number; name: () => string }[] = [
  { id: "60", minutes: 60, name: () => t("bgCap1") },
  { id: "120", minutes: 120, name: () => t("bgCap2") },
  { id: "240", minutes: 240, name: () => t("bgCap4") },
  { id: "0", minutes: 0, name: () => t("bgCapNever") },
];

/** The opt-in "stay connected in the background" mode; turning it on needs the notification permission. */
export function BackgroundPage({ bg, onChange }: { bg: BackgroundSettings; onChange: (s: BackgroundSettings) => void }) {
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = useSupports("background");

  // The permission can be revoked in Android's settings while the mode stays on.
  useEffect(() => {
    if (!bg.enabled) return;
    let alive = true;
    void notificationPermission().then((granted) => alive && setDenied(!granted));
    return () => {
      alive = false;
    };
  }, [bg.enabled]);

  // The switch follows the core: if it could not save, it goes back.
  const apply = async (next: BackgroundSettings) => {
    const prev = bg;
    onChange(next);
    try {
      await setBackgroundSettings(next.enabled, next.capMinutes);
      setFailed(false);
    } catch {
      onChange(prev);
      setFailed(true);
    }
  };
  const toggle = async (on: boolean) => {
    if (!on) {
      setDenied(false);
      await apply({ ...bg, enabled: false });
      return;
    }
    // Without the permission the agents' notifications could not be shown.
    const granted = await requestNotificationPermission();
    setDenied(!granted);
    if (granted) await apply({ ...bg, enabled: true });
  };

  return (
    <Group title={t("secBackground")}>
      <Toggle label={t("bgSwitch")} hint={t("bgHint")} on={bg.enabled} onChange={(on) => void toggle(on)} />
      {!supported && <p className="prof-note set-block">{t("bgNeedsUpdate")}</p>}
      {denied && <p className="prof-note set-block">{t("bgDenied")}</p>}
      {failed && <p className="prof-note set-block" role="alert">{t("bgError")}</p>}
      {bg.enabled && (
        <Segmented
          label={t("bgCap")}
          value={String(bg.capMinutes)}
          options={CAPS.map((c) => ({ id: c.id, name: c.name() }))}
          onChange={(v) => void apply({ ...bg, capMinutes: Number(v) })}
        />
      )}
    </Group>
  );
}
