// The strip order of another PC's tabs, shared by the desktop's remote tab strip and the phone's wide layout.
import type { ChatInfo, Tab } from "./remote-types";

export const ptyKey = (ptyId: string) => `pty:${ptyId}`;
export const chatKey = (chatId: string) => `chat:${chatId}`;

export type RemoteEntry = { key: string; kind: "pty"; tab: Tab } | { key: string; kind: "chat"; chat: ChatInfo };

const orderOf = (e: RemoteEntry) => (e.kind === "pty" ? e.tab.order : e.chat.order);

/** The tabs of a host in strip order: by desktop window (in order of appearance), then as that window's own strip has them.
 * A desktop that sends no positions (older) gets terminals before chats within a window. */
export function remoteEntries(tabs: Tab[], chats: ChatInfo[]): RemoteEntry[] {
  const windows: string[] = [];
  for (const w of [...tabs.map((x) => x.window), ...chats.map((x) => x.window)]) if (!windows.includes(w)) windows.push(w);
  return windows.flatMap((w) => {
    const entries: RemoteEntry[] = [
      ...tabs.filter((x) => x.window === w).map((tab): RemoteEntry => ({ key: ptyKey(tab.ptyId), kind: "pty", tab })),
      ...chats.filter((x) => x.window === w).map((chat): RemoteEntry => ({ key: chatKey(chat.chatId), kind: "chat", chat })),
    ];
    if (!entries.every((e) => typeof orderOf(e) === "number")) return entries;
    // Sort is stable: two entries with the same position (a report in between) keep the order above.
    return entries.sort((a, b) => (orderOf(a) as number) - (orderOf(b) as number));
  });
}
