// The icons of the MCP servers in a chat: asked of the desktop (which fetches the favicon), kept for the session.
import type { McpIconLoader } from "../../shared/mcpIcons";
import { onMessage, send } from "./remote";
import { createStore } from "./store";

/** How long a request may go unanswered (a link that dropped meanwhile) before it counts as "no icon". */
const REPLY_TIMEOUT_MS = 20_000;

/** An icon as a data: URI, null when there is none, "pending" while asked. */
type Entry = string | null | "pending";

const store = createStore<{ entries: Record<string, Entry> }>({ entries: {} });

const setEntry = (server: string, entry: Entry) => store.set({ entries: { ...store.get().entries, [server]: entry } });

/** Asks the desktop for a server's icon, once per server for the session. */
function requestMcpIcon(chatId: string, server: string) {
  if (server in store.get().entries) return;
  setEntry(server, "pending");
  send({ t: "mcpicon", chatId, server });
  setTimeout(() => {
    if (store.get().entries[server] === "pending") setEntry(server, null);
  }, REPLY_TIMEOUT_MS);
}

/** Loads the icons of a chat's servers from the desktop; resolves when the desktop has answered (or not). */
export function mcpIconLoader(chatId: string): McpIconLoader {
  return (server) =>
    new Promise((resolve) => {
      requestMcpIcon(chatId, server);
      const done = () => {
        const entry = store.get().entries[server];
        if (entry === "pending") return;
        unsubscribe();
        resolve(entry ?? null);
      };
      const unsubscribe = store.subscribe(done);
      done();
    });
}

onMessage((m) => {
  if (m.t === "mcpicon") setEntry(m.server, typeof m.icon === "string" && m.icon.startsWith("data:image/") ? m.icon : null);
});
