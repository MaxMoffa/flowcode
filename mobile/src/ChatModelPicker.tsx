import { Fragment, useMemo, useState } from "react";
import type { ChatModelOption, ChatModels, ChatThought } from "../../src/chat/chatTypes";
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

/** How far along the track the current thinking level sits, 0 to 1. */
function thoughtFill(thought: ChatThought): number {
  const at = thought.available.findIndex((l) => l.id === thought.currentId);
  return thought.available.length > 1 && at > 0 ? at / (thought.available.length - 1) : 0;
}

/** Keeps the keyboard where it is while the pill is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** The composer's model pill and the bottom drawer it opens, styled like the mode
 * picker; the newest models come first and older versions sit behind an expandable row.
 * `models` is null when the agent offers no choice (or the desktop can't switch). */
export function ChatModelPicker({
  models,
  thought = null,
  busy,
  onModel,
  onThought,
}: {
  models: ChatModels | null;
  /** The thinking levels (more than one), shown under the models; the pill also shows the current one. */
  thought?: ChatThought | null;
  busy: boolean;
  onModel: (modelId: string) => void;
  onThought?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
  const split = useMemo(() => (models ? splitModelVersions(models.availableModels) : null), [models]);
  const close = () => setOpen(false);
  useEscape(open, close);
  useBackHandler(open, close);
  if ((!models || !split) && !thought) return null;
  const current = models?.availableModels.find((m) => m.modelId === models.currentModelId);
  const modelName = models ? (current?.name ?? models.currentModelId) : null;
  const level = thought ? (thought.available.find((l) => l.id === thought.currentId) ?? null) : null;
  // Without a model choice the pill shows just the level.
  const name = modelName ?? level?.name ?? thought?.currentId ?? "";
  const olderHasCurrent = !!models && !!split && split.older.some((m) => m.modelId === models.currentModelId);

  const renderList = (list: ChatModelOption[]) =>
    list.map((m, i) => {
      const on = m.modelId === models?.currentModelId;
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
      <AdaptiveSheet open={open} onClose={close} variant="drawer" side="right" portal label={t(models ? "chatModel" : "chatThinkingLevel")}>
        <div className="tm-grabber" />
        <header className="tm-sheet-head">
          <h2>{t(models ? "chatModel" : "chatThinkingLevel")}</h2>
          <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="chat-pick-body">
          {busy && <div className="chat-model-hint">{t("chatModelNextTurn")}</div>}
          {models && split && (
            <div role="radiogroup" aria-label={t("chatModel")}>
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
          )}
          {thought && onThought && (
            <div className="chat-think">
              <div className="chat-think-head">
                <span>{t("chatThinkingLevel")}</span>
                <b>{level?.name ?? thought.currentId}</b>
              </div>
              <div
                className="chat-think-seg"
                role="radiogroup"
                aria-label={t("chatThinkingLevel")}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const n = thought.available.length;
                  const at = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left - 14) / (r.width - 28))) * (n - 1));
                  const next = thought.available[at];
                  if (next && next.id !== thought.currentId) {
                    tapFeedback();
                    onThought(next.id);
                  }
                }}
              >
                <i className="chat-think-fill" style={{ width: `calc((100% - 28px) * ${thoughtFill(thought)})` }} aria-hidden="true" />
                {thought.available.map((l, i) => {
                  const on = l.id === thought.currentId;
                  const past = i < thought.available.findIndex((x) => x.id === thought.currentId);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={l.name}
                      className={on ? "on" : past ? "past" : ""}
                      onClick={() => {
                        tapFeedback();
                        if (!on) onThought(l.id);
                      }}
                    >
                      <i aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <div className="chat-think-ends" aria-hidden="true">
                <span>{thought.available[0].name}</span>
                <span>{thought.available[thought.available.length - 1].name}</span>
              </div>
              {level?.description && <div className="chat-think-desc">{level.description}</div>}
            </div>
          )}
        </div>
      </AdaptiveSheet>
      <button
        type="button"
        {...keepFocus}
        className="chat-mode-pill chat-model-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={models ? t("chatModelAria", { name }) + (level ? `, ${t("chatThinkingLevel")}: ${level.name}` : "") : `${t("chatThinkingLevel")}: ${name}`}
        onClick={() => {
          if (!open) setOlderOpen(olderHasCurrent);
          setOpen(!open);
        }}
      >
        <ChipIcon />
        <span>{name}</span>
        <span className="chat-pill-chevron">
          <ChevronDownIcon />
        </span>
      </button>
    </div>
  );
}
