import { useCallback, useEffect, useRef, useState } from "react";
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
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const openedRef = useRef(false);
  openedRef.current = opened;
  useEffect(() => {
    setOpened(false);
    setPending(false);
    setPage(null);
    if (!chatId || !info || !supported) return;
    const track = createAgentOpenTracker(info.cwd);
    for (const event of rawChatEvents(chatId)) track(event, true);
    return onNewChatEvents(chatId, (event, replay) => {
      const open = track(event, replay);
      const next = open && agentPreviewPage(open, chatId, info.cwd, filesSupported);
      if (next) {
        setPage(next);
        // A page that arrives while the user types waits behind a notice instead of taking over.
        const active = document.activeElement;
        const typing = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
        if (!openedRef.current && typing) setPending(true);
        else setOpened(true);
      }
    });
  }, [chatId, info?.cwd, info?.sessionId, supported, filesSupported]);
  const open = useCallback(() => {
    setPending(false);
    setOpened(true);
  }, []);
  const close = useCallback(() => setOpened(false), []);
  const dismissPending = useCallback(() => setPending(false), []);
  const show = useCallback((next: Page) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setPage(next);
    setPending(false);
    setOpened(true);
  }, []);
  return { opened, open, close, show, pending, dismissPending, page, supported, chatId: filesSupported ? chatId : null };
}
