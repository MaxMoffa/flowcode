import { ChatEmptyFrog } from "../../src/chat/ChatEmptyFrog";
import { t } from "./i18n";

/** Between a chat and the fresh one a `/clear` makes: the frog floats in its pond until the new agent is up. */
export function ChatClearing() {
  return (
    <div className="chat-clearing" role="status">
      <ChatEmptyFrog starting />
      <p className="chat-clearing-label">{t("chatClearing")}</p>
    </div>
  );
}
