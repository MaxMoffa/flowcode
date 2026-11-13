import { useMemo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { McpIconSource, type McpIconLoader } from "../../shared/mcpIcons";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";

/** Icon requests by chat and server, kept for the session: each server is fetched once. */
const icons = new Map<string, Promise<string | null>>();

const cached = (key: string, load: () => Promise<string | null>): Promise<string | null> => {
  let hit = icons.get(key);
  if (!hit) {
    hit = load().catch(() => null);
    icons.set(key, hit);
  }
  return hit;
};

/** Loads the MCP server icons of a chat running on this PC. */
export function LocalMcpIconProvider({ chatId, children }: { chatId: string | null; children: ReactNode }) {
  const { chatMcpIcons } = useTerminalSettings();
  const loader = useMemo<McpIconLoader | null>(
    () => (chatMcpIcons ? (server) => cached(`${chatId ?? ""}:${server}`, () => invoke<string | null>("mcp_icon", { chatId, server })) : null),
    [chatMcpIcons, chatId],
  );
  return <McpIconSource.Provider value={loader}>{children}</McpIconSource.Provider>;
}
