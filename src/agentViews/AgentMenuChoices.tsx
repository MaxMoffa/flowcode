import { useI18n } from "../i18n";
import type { ChatModels, ChatModes } from "../chat/chatTypes";

interface AgentMenuChoicesProps {
  modes: ChatModes | null;
  /** The mode in use (the live one from events, else the announced one). */
  currentModeId: string | null;
  models: ChatModels | null;
  onMode: (modeId: string) => void;
  onModel: (modelId: string) => void;
  /** A separator after each group shown. */
  separated?: boolean;
}

/** The mode and model radio groups of an agent session's header menu (a chat here or on another PC). */
export function AgentMenuChoices({ modes, currentModeId, models, onMode, onModel, separated }: AgentMenuChoicesProps) {
  const { t } = useI18n();
  const sep = separated ? <div className="chat-menu-sep" role="separator" /> : null;
  return (
    <>
      {modes && modes.availableModes.length > 0 && (
        <>
          <div className="chat-menu-caption">{t("chat.menu.mode")}</div>
          {modes.availableModes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode.id === currentModeId}
              className="chat-menu-item"
              title={mode.description}
              onClick={() => onMode(mode.id)}
            >
              <span className="chat-menu-check">{mode.id === currentModeId ? "✓" : ""}</span>
              <span>{mode.name}</span>
            </button>
          ))}
          {sep}
        </>
      )}
      {models && (
        <>
          <div className="chat-menu-caption">{t("chat.menu.model")}</div>
          {models.availableModels.map((m) => (
            <button
              key={m.modelId}
              type="button"
              role="menuitemradio"
              aria-checked={m.modelId === models.currentModelId}
              className="chat-menu-item"
              title={[m.group, m.description].filter(Boolean).join(" · ") || undefined}
              onClick={() => onModel(m.modelId)}
            >
              <span className="chat-menu-check">{m.modelId === models.currentModelId ? "✓" : ""}</span>
              <span>{m.name}</span>
            </button>
          ))}
          {sep}
        </>
      )}
    </>
  );
}
