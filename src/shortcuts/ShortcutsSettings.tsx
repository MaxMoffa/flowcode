import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { SettingRow, SettingsGroup } from "../settings/SettingsControls";
import { useShortcutsConfig } from "./ShortcutsContext";
import { ShortcutKeys } from "./ShortcutKeys";
import {
  RESERVED_COMBOS,
  SHORTCUT_GROUP_ORDER,
  actionsOfGroup,
  canonicalCombo,
  eventToShortcutString,
  isModifierOnly,
  isValidCombo,
  type ShortcutAction,
} from "./shortcuts";

/** Settings > Scorciatoie: one row per action; click the combo, press the
 * new keys. */
export function ShortcutsSettings({ onOpenGuide }: { onOpenGuide: () => void }) {
  const { t } = useI18n();
  const { shortcuts, defaults, setShortcut, resetShortcut, resetAll, setSuspended } = useShortcutsConfig();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null);

  // While recording, every key belongs to the recorder: the global handler
  // is switched off, and the combo pressed is captured instead of run.
  useEffect(() => {
    if (!recording) return;
    setSuspended(true);

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || isModifierOnly(e)) return;
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = eventToShortcutString(e);
      if (!isValidCombo(combo)) {
        setError({ action: recording, message: t("shortcuts.error.needsModifier") });
        return;
      }
      if (RESERVED_COMBOS.includes(combo)) {
        setError({ action: recording, message: t("shortcuts.error.reserved", { combo }) });
        return;
      }
      const canonical = canonicalCombo(combo);
      const clash = (Object.keys(shortcuts) as ShortcutAction[]).find(
        (other) => other !== recording && shortcuts[other] && canonicalCombo(shortcuts[other]) === canonical,
      );
      if (clash) {
        setError({ action: recording, message: t("shortcuts.error.conflict", { combo, action: t(`shortcuts.action.${clash}`) }) });
        return;
      }
      setShortcut(recording, combo);
      setError(null);
      setRecording(null);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".shortcut-recorder.is-recording")) setRecording(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      setSuspended(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, shortcuts]);

  const anyChanged = (Object.keys(defaults) as ShortcutAction[]).some((a) => shortcuts[a] !== defaults[a]);

  return (
    <>
      <SettingsGroup title={t("shortcuts.guide.label")}>
        <SettingRow id="shortcutsGuide" label={t("shortcuts.guide.label")} desc={t("shortcuts.guide.settingsDesc")}>
          <button type="button" className="settings-choice" onClick={onOpenGuide}>
            {t("shortcuts.guide.button")}
          </button>
        </SettingRow>
        <SettingRow id="shortcutsResetAll" label={t("shortcuts.resetAll.label")} desc={t("shortcuts.resetAll.desc")}>
          <button type="button" className="settings-choice is-danger" disabled={!anyChanged} onClick={resetAll}>
            {t("shortcuts.resetAll.button")}
          </button>
        </SettingRow>
      </SettingsGroup>

      {SHORTCUT_GROUP_ORDER.map((group) => (
        <SettingsGroup key={group} title={t(`shortcuts.group.${group}`)}>
          {actionsOfGroup(group).map((action) => {
            const name = t(`shortcuts.action.${action}`);
            const combo = shortcuts[action] ?? "";
            const isRecording = recording === action;
            const changed = combo !== defaults[action];
            return (
              <SettingRow
                key={action}
                id={`shortcut-${action}`}
                label={name}
                desc={error?.action === action ? <span className="shortcut-error">{error.message}</span> : undefined}
              >
                <div className="shortcut-controls">
                  <button
                    type="button"
                    className={"shortcut-recorder" + (isRecording ? " is-recording" : "")}
                    aria-label={t("shortcuts.change", { name })}
                    onClick={() => {
                      setError(null);
                      setRecording(isRecording ? null : action);
                    }}
                  >
                    {isRecording ? (
                      <span className="shortcut-recording">{t("shortcuts.recording")}</span>
                    ) : combo ? (
                      <ShortcutKeys combo={combo} />
                    ) : (
                      <span className="shortcut-unassigned">{t("shortcuts.unassigned")}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="shortcut-icon-btn"
                    title={t("shortcuts.reset")}
                    aria-label={t("shortcuts.reset")}
                    disabled={!changed}
                    onClick={() => {
                      setError(null);
                      resetShortcut(action);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
                      <path d="M4 4.5v4h4" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="shortcut-icon-btn"
                    title={t("shortcuts.clear")}
                    aria-label={t("shortcuts.clear")}
                    disabled={!combo}
                    onClick={() => {
                      setError(null);
                      setShortcut(action, "");
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                  </button>
                </div>
              </SettingRow>
            );
          })}
        </SettingsGroup>
      ))}
    </>
  );
}
