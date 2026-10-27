import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { useOutsideClose } from "../hooks/useOutsideClose";
import type { ChatSession } from "./useChat";

function ChipIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </svg>
  );
}

/** The composer's model pill (beside the mode one) and the menu it opens
 * upward; hidden unless the agent offers a choice of models. */
export default function ChatModelSelect({ chat }: { chat: Pick<ChatSession, "models" | "setModel" | "model"> }) {
  const { t } = useI18n();
  const models = chat.models;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClose(open, [anchorRef], () => setOpen(false), { escape: true });

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const current = Array.from(items).find((el) => el.getAttribute("aria-checked") === "true");
    (current ?? items[0]).focus();
  }, [open]);

  if (!models) return null;
  const currentId = models.currentModelId;
  const current = models.availableModels.find((m) => m.modelId === currentId);
  const busy = chat.model.status === "busy" || chat.model.status === "waiting";

  const close = () => {
    setOpen(false);
    pillRef.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="chat-mode-anchor" ref={anchorRef}>
      <button
        ref={pillRef}
        type="button"
        className="chat-mode-pill chat-model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={busy ? `${t("chat.model.change")} - ${t("chat.model.nextTurn")}` : t("chat.model.change")}
        onClick={() => setOpen((o) => !o)}
      >
        <ChipIcon size={15} />
        <span className="chat-mode-name">{current?.name ?? currentId}</span>
      </button>
      {open && (
        <div className="chat-menu chat-mode-menu chat-model-menu" role="menu" aria-label={t("chat.menu.model")} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="chat-mode-caption">{t("chat.menu.model")}</div>
          {busy && <div className="chat-model-hint">{t("chat.model.nextTurn")}</div>}
          {models.availableModels.map((m, i) => {
            const selected = m.modelId === currentId;
            const newGroup = m.group && m.group !== models.availableModels[i - 1]?.group;
            return (
              <Fragment key={m.modelId}>
                {newGroup && <div className="chat-model-group">{m.group}</div>}
                <div className={`chat-mode-row${selected ? " is-selected" : ""}`}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="chat-mode-item"
                    onClick={() => {
                      close();
                      if (!selected) chat.setModel(m.modelId);
                    }}
                  >
                    <span className="chat-model-check" aria-hidden="true">
                      {selected ? "✓" : ""}
                    </span>
                    <span className="chat-mode-text">
                      <span className="chat-mode-title">{m.name}</span>
                      {m.description && <span className="chat-mode-desc">{m.description}</span>}
                    </span>
                  </button>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
