import { useEffect } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import {
  DICTATION_LANGUAGES,
  cancelDownload,
  deleteModel,
  downloadModel,
  downloadPercent,
  ellipsizeMiddle,
  ensureModelsLoaded,
  formatMb,
  modelDescription,
  modelForSession,
  modelName,
  setDictationLanguage,
  setSelectedModel,
  useDictationLanguage,
  useDictationModels,
  useSelectedModel,
} from "../chat/dictationModels";
import { Segmented, SettingRow, SettingsGroup } from "./SettingsControls";
import "./dictation-settings.css";

/** Settings > Agenti > Dettatura: the local Whisper models (use, download,
 * delete) and the spoken language. Shares its state with the chat mic. */
export function DictationSettings() {
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  const { models, dir, downloading } = useDictationModels();
  const selected = useSelectedModel();
  const language = useDictationLanguage();
  useEffect(ensureModelsLoaded, []);

  // What the mic really uses: the chosen model if installed, else the backend's pick.
  const inUse = modelForSession(models, selected) ?? models.find((m) => m.installed)?.id ?? null;
  const usedBytes = models.filter((m) => m.installed).reduce((sum, m) => sum + m.sizeBytes, 0);

  async function handleDelete(id: string, sizeBytes: number) {
    const ok = await confirm({
      title: t("settings.dictation.model.deleteTitle", { name: modelName(id) }),
      message: t("settings.dictation.model.deleteConfirm", { size: formatMb(sizeBytes) }),
      confirmLabel: t("settings.dictation.model.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteModel(id);
    } catch (e) {
      window.alert(t("settings.dictation.model.deleteFailed", { error: String(e) }));
    }
  }

  return (
    <SettingsGroup title={t("settings.group.dictation")} desc={t("settings.dictation.intro")}>
      <SettingRow id="dictationModel" label={t("settings.dictation.model.label")} desc={t("settings.dictation.model.desc")} stacked>
        <div className="dictation-settings-models">
          {models.map((m) => {
            const running = downloading?.id === m.id ? downloading : null;
            return (
              <div key={m.id} className="dictation-settings-model">
                <div className="dictation-settings-model-text">
                  <div className="dictation-settings-model-name">
                    {modelName(m.id)}
                    <span className="dictation-settings-model-size">{formatMb(m.sizeBytes)} MB</span>
                  </div>
                  <div className="dictation-settings-model-desc">{modelDescription(m.id)}</div>
                </div>
                <div className="dictation-settings-model-actions">
                  {m.installed ? (
                    <>
                      {inUse === m.id ? (
                        <span className="dictation-settings-model-state">{t("settings.dictation.model.inUse")}</span>
                      ) : (
                        <button type="button" className="settings-choice" onClick={() => setSelectedModel(m.id)}>
                          {t("settings.dictation.model.use")}
                        </button>
                      )}
                      <button type="button" className="settings-choice" onClick={() => void handleDelete(m.id, m.sizeBytes)}>
                        {t("settings.dictation.model.delete")}
                      </button>
                    </>
                  ) : running ? (
                    <>
                      <span className="dictation-settings-model-state">
                        {t("settings.dictation.model.downloading", { percent: downloadPercent(running.received, running.total) })}
                      </span>
                      <button type="button" className="settings-choice" onClick={cancelDownload}>
                        {t("settings.dictation.model.cancel")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="settings-choice" disabled={downloading !== null} onClick={() => void downloadModel(m.id)}>
                      {t("settings.dictation.model.download", { size: formatMb(m.sizeBytes) })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow id="dictationSpace" label={t("settings.dictation.space.label")} desc={t("settings.dictation.space.desc")}>
        <span title={dir}>{t("settings.dictation.space.value", { size: formatMb(usedBytes), dir: ellipsizeMiddle(dir, 40) })}</span>
      </SettingRow>
      <SettingRow id="dictationLanguage" label={t("settings.dictation.language.label")} desc={t("settings.dictation.language.desc")}>
        <Segmented
          value={language}
          options={DICTATION_LANGUAGES.map((l) => ({ value: l, label: t(`settings.dictation.language.${l}` as MessageKey) }))}
          onChange={setDictationLanguage}
          ariaLabel={t("settings.dictation.language.label")}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
