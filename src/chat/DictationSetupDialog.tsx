import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import {
  cancelDownload,
  clearDownloadError,
  defaultModelId,
  downloadModel,
  downloadPercent,
  ellipsizeMiddle,
  formatMb,
  modelDescription,
  modelName,
  useDictationModels,
} from "./dictationModels";
import "../dialog/modal.css";
import "./dictation-dialog.css";

/** First-use dialog of the local dictation: pick a Whisper model and download
 * it, or follow the download already running. Closing it never stops a
 * download; "Annulla download" does. */
export function DictationSetupDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { models, dir, downloading, error, failedId } = useDictationModels();
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? failedId ?? defaultModelId(models);
  const chosen = models.find((m) => m.id === choice);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  useEffect(() => clearDownloadError, []);

  const percent = downloading ? downloadPercent(downloading.received, downloading.total) : 0;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel dictation-dialog" role="dialog" aria-modal="true" aria-labelledby="dictation-dialog-title">
        {downloading ? (
          <>
            <h3 id="dictation-dialog-title" className="dictation-dialog-title">
              {t("chat.dictate.setup.downloading", { name: modelName(downloading.id) })}
            </h3>
            <div className="dictation-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="dictation-progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="dictation-progress-meta">
              <span>{t("chat.dictate.setup.progress", { received: formatMb(downloading.received), total: formatMb(downloading.total) })}</span>
              <span>{percent}%</span>
            </div>
            <p className="dictation-dialog-text">{t("chat.dictate.setup.background")}</p>
            <div className="dictation-dialog-actions">
              <button type="button" className="dictation-btn is-ghost" onClick={cancelDownload}>
                {t("chat.dictate.setup.cancelDownload")}
              </button>
              <button type="button" className="dictation-btn" onClick={onClose}>
                {t("chat.dictate.setup.continueBackground")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 id="dictation-dialog-title" className="dictation-dialog-title">
              {t("chat.dictate.setup.title")}
            </h3>
            <p className="dictation-dialog-text">{t("chat.dictate.setup.intro")}</p>
            <div className="dictation-models" role="radiogroup" aria-label={t("chat.dictate.setup.models")}>
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === choice}
                  className={"dictation-model" + (m.id === choice ? " is-selected" : "")}
                  onClick={() => setPicked(m.id)}
                >
                  <span className="dictation-model-radio" aria-hidden="true" />
                  <span className="dictation-model-body">
                    <span className="dictation-model-name">
                      {modelName(m.id)}
                      {m.recommended && <span className="dictation-model-tag">{t("chat.dictate.setup.recommended")}</span>}
                    </span>
                    <span className="dictation-model-desc">{modelDescription(m.id)}</span>
                  </span>
                  <span className="dictation-model-size">{formatMb(m.sizeBytes)} MB</span>
                </button>
              ))}
            </div>
            <dl className="dictation-facts">
              <dt>{t("chat.dictate.setup.space")}</dt>
              <dd title={dir}>
                {chosen ? t("chat.dictate.setup.spaceValue", { size: formatMb(chosen.sizeBytes), dir: ellipsizeMiddle(dir, 44) }) : ""}
              </dd>
              <dt>{t("chat.dictate.setup.manage")}</dt>
              <dd>{t("chat.dictate.setup.manageValue")}</dd>
            </dl>
            {error && (
              <p className="dictation-dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="dictation-dialog-actions">
              <button type="button" className="dictation-btn is-ghost" onClick={onClose}>
                {t("chat.dictate.setup.notNow")}
              </button>
              <button type="button" className="dictation-btn is-primary" disabled={!chosen} onClick={() => chosen && void downloadModel(chosen.id)}>
                {t(error ? "chat.dictate.setup.retry" : "chat.dictate.setup.download", { size: chosen ? formatMb(chosen.sizeBytes) : 0 })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
