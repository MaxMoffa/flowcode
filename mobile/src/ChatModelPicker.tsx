import { Fragment, useState } from "react";
import type { ChatModels } from "../../src/chat/chatTypes";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { CheckIcon, Svg } from "./icons";

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

/** The composer's model pill and the list it opens upward, styled like the mode
 * picker; `models` is null when the agent offers no choice (or the desktop can't switch). */
export function ChatModelPicker({ models, busy, onModel }: { models: ChatModels | null; busy: boolean; onModel: (modelId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!models) return null;
  const current = models.availableModels.find((m) => m.modelId === models.currentModelId);
  const name = current?.name ?? models.currentModelId;
  return (
    <div className="chat-mode chat-model">
      {open && (
        <>
          <div className="chat-mode-scrim" onClick={() => setOpen(false)} />
          <div className="chat-mode-list chat-model-list" role="radiogroup" aria-label={t("chatModel")}>
            <div className="chat-mode-caption">{t("chatModel")}</div>
            {busy && <div className="chat-model-hint">{t("chatModelNextTurn")}</div>}
            {models.availableModels.map((m, i) => {
              const on = m.modelId === models.currentModelId;
              const newGroup = m.group && m.group !== models.availableModels[i - 1]?.group;
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
                        setOpen(false);
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
            })}
          </div>
        </>
      )}
      <button type="button" {...keepFocus} className="chat-mode-pill chat-model-pill" aria-haspopup="true" aria-expanded={open} aria-label={t("chatModelAria", { name })} onClick={() => setOpen(!open)}>
        <ChipIcon />
        <span>{name}</span>
      </button>
    </div>
  );
}
