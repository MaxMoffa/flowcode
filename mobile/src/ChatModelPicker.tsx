import { Fragment, useMemo, useState } from "react";
import type { ChatModelOption, ChatModels } from "../../src/chat/chatTypes";
import { splitModelVersions } from "../../src/chat/modelVersions";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { CheckIcon, ChevronDownIcon, CloseIcon, Svg } from "./icons";

const ChipIcon = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Svg>
);

/** Keeps the keyboard where it is while the pill is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** The composer's model pill and the bottom drawer it opens, styled like the mode
 * picker; the newest models come first and older versions sit behind an expandable row.
 * `models` is null when the agent offers no choice (or the desktop can't switch). */
export function ChatModelPicker({ models, busy, onModel }: { models: ChatModels | null; busy: boolean; onModel: (modelId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
  const split = useMemo(() => (models ? splitModelVersions(models.availableModels, models.currentModelId) : null), [models]);
  const close = () => setOpen(false);
  useEscape(open, close);
  useBackHandler(open, close);
  if (!models || !split) return null;
  const current = models.availableModels.find((m) => m.modelId === models.currentModelId);
  const name = current?.name ?? models.currentModelId;
  const olderHasCurrent = split.older.some((m) => m.modelId === models.currentModelId);

  const renderList = (list: ChatModelOption[]) =>
    list.map((m, i) => {
      const on = m.modelId === models.currentModelId;
      const newGroup = m.group && m.group !== list[i - 1]?.group;
      return (
        <Fragment key={m.modelId}>
          {newGroup && <div className="chat-model-group">{m.group}</div>}
          <div className={"chat-mode-row" + (on ? " on" : "")}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              className="chat-mode-pick"
              onClick={() => {
                tapFeedback();
                close();
                if (!on) onModel(m.modelId);
              }}
            >
              <span className="chat-model-check">{on && <CheckIcon />}</span>
              <span className="chat-mode-text">
                <span className="chat-mode-name">{m.name}</span>
                {m.description && <span className="chat-mode-desc">{m.description}</span>}
              </span>
            </button>
          </div>
        </Fragment>
      );
    });

  return (
    <div className="chat-mode chat-model">
      <AdaptiveSheet open={open} onClose={close} variant="drawer" side="right" portal label={t("chatModel")}>
        <div className="tm-grabber" />
        <header className="tm-sheet-head">
          <h2>{t("chatModel")}</h2>
          <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="chat-pick-body" role="radiogroup" aria-label={t("chatModel")}>
          {busy && <div className="chat-model-hint">{t("chatModelNextTurn")}</div>}
          {renderList(split.latest)}
          {split.older.length > 0 && (
            <>
              <div className="chat-mode-row">
                <button
                  type="button"
                  className="chat-mode-pick"
                  aria-expanded={olderOpen}
                  onClick={() => {
                    tapFeedback();
                    setOlderOpen(!olderOpen);
                  }}
                >
                  <span className="chat-mode-text">
                    <span className="chat-mode-name">{t("chatModelOlder")}</span>
                    {!olderOpen && olderHasCurrent && <span className="chat-mode-desc">{name}</span>}
                  </span>
                  <span className={"chat-model-chevron" + (olderOpen ? " open" : "")}>
                    <ChevronDownIcon />
                  </span>
                </button>
              </div>
              {olderOpen && renderList(split.older)}
            </>
          )}
        </div>
      </AdaptiveSheet>
      <button
        type="button"
        {...keepFocus}
        className="chat-mode-pill chat-model-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("chatModelAria", { name })}
        onClick={() => {
          if (!open) setOlderOpen(olderHasCurrent);
          setOpen(!open);
        }}
      >
        <ChipIcon />
        <span>{name}</span>
      </button>
    </div>
  );
}
