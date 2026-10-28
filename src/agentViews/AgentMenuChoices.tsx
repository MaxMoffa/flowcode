import { useI18n } from "../i18n";
import type { ChatModes } from "../chat/chatTypes";

interface AgentMenuChoicesProps {
  modes: ChatModes | null;
  /** The mode in use (the live one from events, else the announced one). */
  currentModeId: string | null;
  onMode: (modeId: string) => void;
  /** A separator after each group shown. */
  separated?: boolean;
}

/** The mode radio group of an agent session's header menu (a chat here or on another PC). Models live in the composer's model pill. */
export function AgentMenuChoices({ modes, currentModeId, onMode, separated }: AgentMenuChoicesProps) {
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
    </>
  );
}
