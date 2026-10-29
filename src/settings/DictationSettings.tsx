import { useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import {
  COMMON_DICTATION_LANGUAGES,
  WHISPER_LANGUAGES,
  cancelDownload,
  deleteModel,
  downloadModel,
  downloadPercent,
  ellipsizeMiddle,
  ensureModelsLoaded,
  formatMb,
  languageName,
  modelDescription,
  modelForSession,
  modelName,
  setDictationAutoSend,
  setDictationLanguages,
  setDictationSpaceHold,
  setDictationSpaceTap,
  setSelectedModel,
  useDictationAutoSend,
  useDictationLanguages,
  useDictationModels,
  useDictationShortcuts,
  useSelectedModel,
} from "../chat/dictationModels";
import { Segmented, SettingRow, Switch, settingDomId } from "./SettingsControls";
import "./dictation-settings.css";

/** Speed / accuracy of each known model on a 1-5 scale. Unknown ids get no meters. */
const MODEL_METERS: Record<string, { speed: number; precision: number }> = {
  "small-q5": { speed: 4, precision: 4 },
  small: { speed: 3, precision: 5 },
  base: { speed: 5, precision: 3 },
};

type LanguageMode = "auto" | "pick";

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span>{label}</span>
      <span className="dictation-settings-bar" role="img" aria-label={`${label} ${value}/5`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <i key={i} className={i <= value ? "is-on" : undefined} />
        ))}
      </span>
    </>
  );
}

/** Settings > Agenti > Dettatura: the local Whisper models (use, download,
 * delete), the spoken languages and the dictation shortcuts. Shares its state
 * with the chat mic. */
export function DictationSettings() {
  const { t, language: uiLanguage } = useI18n();
  const confirm = useConfirmDialog();
  const { models, dir, downloading } = useDictationModels();
  const selected = useSelectedModel();
  const languages = useDictationLanguages();
  const autoSend = useDictationAutoSend();
  const shortcuts = useDictationShortcuts();
  const [query, setQuery] = useState("");
  const lastPick = useRef<readonly string[]>([]);
  useEffect(ensureModelsLoaded, []);
  if (languages.length > 0) lastPick.current = languages;

  // What the mic really uses: the chosen model if installed, else the backend's pick.
  const inUse = modelForSession(models, selected) ?? models.find((m) => m.installed)?.id ?? null;
  const usedBytes = models.filter((m) => m.installed).reduce((sum, m) => sum + m.sizeBytes, 0);

  const mode: LanguageMode = languages.length === 0 ? "auto" : "pick";

  const { common, others } = useMemo(() => {
    const commonSet = new Set<string>(COMMON_DICTATION_LANGUAGES);
    const q = query.trim().toLowerCase();
    const match = (code: string) => !q || languageName(code).toLowerCase().includes(q) || code.toLowerCase().startsWith(q);
    return {
      common: COMMON_DICTATION_LANGUAGES.filter(match),
      others: WHISPER_LANGUAGES.filter((c) => !commonSet.has(c))
        .sort((a, b) => languageName(a).localeCompare(languageName(b)))
        .filter(match),
    };
  }, [query]);

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

  function changeMode(next: LanguageMode) {
    if (next === mode) return;
    if (next === "auto") {
      setDictationLanguages([]);
      return;
    }
    const fallback = (WHISPER_LANGUAGES as readonly string[]).includes(uiLanguage) ? uiLanguage : "en";
    setDictationLanguages(lastPick.current.length > 0 ? lastPick.current : [fallback]);
  }

  function toggleLanguage(code: string) {
    if (languages.includes(code)) {
      if (languages.length <= 1) return; // the last one stays
      setDictationLanguages(languages.filter((c) => c !== code));
    } else {
      setDictationLanguages([...languages, code]);
    }
  }

  const hint =
    mode === "auto"
      ? t("settings.dictation.language.hint.auto")
      : languages.length === 1
        ? t("settings.dictation.language.hint.one", { name: languageName(languages[0]) })
        : t("settings.dictation.language.hint.many", { count: languages.length });

  const languageItem = (code: string) => (
    <label key={code} className="dictation-settings-lang">
      <input type="checkbox" checked={languages.includes(code)} onChange={() => toggleLanguage(code)} />
      <span className="dictation-settings-check" aria-hidden="true" />
      <span className="dictation-settings-lang-name">{languageName(code)}</span>
      <small>{code}</small>
    </label>
  );

  return (
    <section className="settings-group dictation-settings">
      <h3 className="settings-group-title">{t("settings.group.dictation")}</h3>
      <p className="settings-group-desc dictation-settings-intro">
        <span className="dictation-settings-local">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" />
          </svg>
          {t("settings.dictation.local")}
        </span>
        <span>{t("settings.dictation.intro")}</span>
      </p>

      {/* Models */}
      <div id={settingDomId("dictationModel")} className="dictation-settings-section">
        <div className="dictation-settings-head">
          <span className="dictation-settings-title">{t("settings.dictation.model.label")}</span>
          <span className="dictation-settings-aside">{t("settings.dictation.model.desc")}</span>
        </div>
        <div className="dictation-settings-models" role="radiogroup" aria-label={t("settings.dictation.model.label")}>
          {models.map((m) => {
            const running = downloading?.id === m.id ? downloading : null;
            const isSelected = inUse === m.id;
            const meters = MODEL_METERS[m.id];
            const percent = running ? downloadPercent(running.received, running.total) : 0;
            return (
              <div
                key={m.id}
                role="radio"
                aria-checked={isSelected}
                aria-disabled={!m.installed}
                tabIndex={m.installed ? 0 : -1}
                className={
                  "dictation-settings-model" + (isSelected ? " is-selected" : "") + (m.installed ? "" : " is-disabled")
                }
                onClick={() => m.installed && setSelectedModel(m.id)}
                onKeyDown={(e) => {
                  if (m.installed && e.target === e.currentTarget && (e.key === " " || e.key === "Enter")) {
                    e.preventDefault();
                    setSelectedModel(m.id);
                  }
                }}
              >
                <div className="dictation-settings-model-top">
                  <span className="dictation-settings-radio" aria-hidden="true" />
                  <span className="dictation-settings-model-name">{modelName(m.id)}</span>
                  {m.recommended && <span className="dictation-settings-badge">{t("settings.dictation.model.recommended")}</span>}
                </div>
                <div className="dictation-settings-model-desc">{modelDescription(m.id)}</div>
                {meters && (
                  <div className="dictation-settings-meters">
                    <Meter label={t("settings.dictation.model.speed")} value={meters.speed} />
                    <Meter label={t("settings.dictation.model.precision")} value={meters.precision} />
                  </div>
                )}
                <div className="dictation-settings-model-foot">
                  {m.installed ? (
                    <>
                      <span className="dictation-settings-ok">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                          <path d="m3 8.5 3 3 7-7" />
                        </svg>
                        {t("settings.dictation.model.installedSize", {
                          state: isSelected ? t("settings.dictation.model.inUse") : t("settings.dictation.model.installed"),
                          size: formatMb(m.sizeBytes),
                        })}
                      </span>
                      <button
                        type="button"
                        className="dictation-settings-icon-btn"
                        title={t("settings.dictation.model.delete")}
                        aria-label={t("settings.dictation.model.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(m.id, m.sizeBytes);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
                        </svg>
                      </button>
                    </>
                  ) : running ? (
                    <>
                      <div className="dictation-settings-progress">
                        <span>{t("settings.dictation.model.downloading", { percent })}</span>
                        <div className="dictation-settings-progress-track">
                          <div className="dictation-settings-progress-fill" style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                      <button
                        type="button"
                        className="settings-choice"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelDownload();
                        }}
                      >
                        {t("settings.dictation.model.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <span>{t("settings.dictation.model.sizeOnly", { size: formatMb(m.sizeBytes) })}</span>
                      <button
                        type="button"
                        className="settings-choice dictation-settings-primary"
                        disabled={downloading !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void downloadModel(m.id);
                        }}
                      >
                        {t("settings.dictation.model.download")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="dictation-settings-storage">
          <span>{t("settings.dictation.storage.used", { size: formatMb(usedBytes) })}</span>
          <code title={dir}>{ellipsizeMiddle(dir, 40)}</code>
          <button type="button" className="dictation-settings-link" disabled={!dir} onClick={() => revealItemInDir(dir).catch(() => {})}>
            {t("settings.dictation.storage.open")}
          </button>
        </div>
      </div>

      {/* Languages */}
      <div id={settingDomId("dictationLanguage")} className="dictation-settings-section">
        <div className="dictation-settings-head">
          <span className="dictation-settings-title">{t("settings.dictation.language.label")}</span>
          <span className="dictation-settings-aside">
            {mode === "auto"
              ? t("settings.dictation.language.aside.auto")
              : t("settings.dictation.language.aside.count", { count: languages.length })}
          </span>
        </div>
        <div className="settings-card dictation-settings-lang-card">
          <Segmented<LanguageMode>
            value={mode}
            options={[
              { value: "auto", label: t("settings.dictation.language.mode.auto") },
              { value: "pick", label: t("settings.dictation.language.mode.pick") },
            ]}
            onChange={changeMode}
            ariaLabel={t("settings.dictation.language.label")}
          />
          <p className="dictation-settings-hint">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7.5v3.5M8 5h.01" />
            </svg>
            <span>{hint}</span>
          </p>
          {mode === "pick" && (
            <div>
              <div className="dictation-settings-chips">
                {languages.map((code) => (
                  <span key={code} className="dictation-settings-chip">
                    {languageName(code)}
                    {languages.length > 1 && (
                      <button
                        type="button"
                        title={t("settings.dictation.language.remove", { name: languageName(code) })}
                        aria-label={t("settings.dictation.language.remove", { name: languageName(code) })}
                        onClick={() => toggleLanguage(code)}
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                          <path d="M1 1l6 6M7 1 1 7" />
                        </svg>
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="dictation-settings-search">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="m10.5 10.5 3 3" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.dictation.language.search", { count: WHISPER_LANGUAGES.length })}
                  aria-label={t("settings.dictation.language.searchLabel")}
                />
              </div>
              <div className="dictation-settings-lang-list" role="group" aria-label={t("settings.dictation.language.label")}>
                {common.length > 0 && <div className="dictation-settings-lang-group">{t("settings.dictation.language.common")}</div>}
                {common.map(languageItem)}
                {others.length > 0 && <div className="dictation-settings-lang-group">{t("settings.dictation.language.all")}</div>}
                {others.map(languageItem)}
                {common.length === 0 && others.length === 0 && (
                  <div className="dictation-settings-lang-group">{t("settings.dictation.language.none")}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Shortcuts */}
      <div className="dictation-settings-section">
        <div className="dictation-settings-head">
          <span className="dictation-settings-title">{t("settings.dictation.shortcuts.title")}</span>
          <span className="dictation-settings-aside">{t("settings.dictation.shortcuts.aside")}</span>
        </div>
        <div className="settings-card dictation-settings-shortcuts">
          <SettingRow
            id="dictationSpaceTap"
            label={t("settings.dictation.spaceTap.label")}
            desc={t("settings.dictation.spaceTap.desc")}
          >
            <kbd className="dictation-settings-kbd">{t("settings.dictation.spaceTap.key")}</kbd>
            <Switch checked={shortcuts.tap} onChange={setDictationSpaceTap} label={t("settings.dictation.spaceTap.label")} />
          </SettingRow>
          <SettingRow
            id="dictationSpaceHold"
            label={t("settings.dictation.spaceHold.label")}
            desc={t("settings.dictation.spaceHold.desc")}
          >
            <kbd className="dictation-settings-kbd">{t("settings.dictation.spaceHold.key")}</kbd>
            <Switch checked={shortcuts.hold} onChange={setDictationSpaceHold} label={t("settings.dictation.spaceHold.label")} />
          </SettingRow>
          <SettingRow
            id="dictationAutoSend"
            label={t("settings.dictation.autoSend.label")}
            desc={t("settings.dictation.autoSend.desc")}
          >
            <kbd className="dictation-settings-kbd">{t("settings.dictation.autoSend.key")}</kbd>
            <Switch checked={autoSend} onChange={setDictationAutoSend} label={t("settings.dictation.autoSend.label")} />
          </SettingRow>
        </div>
      </div>
    </section>
  );
}
