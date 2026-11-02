import { useEffect, useState } from "react";
import { createAgentOpenTracker } from "../../shared/agentOpen";
import { agentPreviewPage } from "./agentPreview";
import { onNewChatEvents, rawChatEvents, useChatInfo } from "./chats";
import type { Page } from "./browserUrl";
import { useSupports } from "./remote";

/** The visible chat follows successful live openers, never history. */
export function useChatBrowser(chatId: string | null) {
  const info = useChatInfo(chatId);
  const supported = useSupports("preview");
  const filesSupported = useSupports("chatPreview");
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    setOpened(false);
    setPage(null);
    if (!chatId || !info || !supported) return;
    const track = createAgentOpenTracker(info.cwd);
    for (const event of rawChatEvents(chatId)) track(event, true);
    return onNewChatEvents(chatId, (event, replay) => {
      const open = track(event, replay);
      const next = open && agentPreviewPage(open, chatId, info.cwd, filesSupported);
      if (next) {
        setPage(next);
        setOpened(true);
      }
    });
  }, [chatId, info?.cwd, info?.sessionId, supported, filesSupported]);
  return { opened, setOpened, page, supported, chatId: filesSupported ? chatId : null };
}
