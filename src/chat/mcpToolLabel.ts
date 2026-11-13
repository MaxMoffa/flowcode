/** A call to an MCP tool split into a readable server and tool. Claude names it `mcp__<server>__<tool>` (`_meta.claudeCode.toolName`), Codex titles it `mcp.<server>.<tool>` with `{ server, tool }` in its raw input. */
export interface McpLabel {
  server: string;
  tool: string;
  /** The name as the agent sent it (tooltip). */
  raw: string;
}

interface CallLike {
  toolName?: string;
  title?: string | null;
  rawInput?: unknown;
}

const CODEX_TITLE = /^mcp\.([^.\s]+)\.(\S+)$/;

function split(call: CallLike): { server: string; tool: string; raw: string } | null {
  const name = call.toolName ?? "";
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const sep = rest.indexOf("__");
    if (sep > 0 && rest.length > sep + 2) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2), raw: name };
  }
  const title = (call.title ?? "").trim();
  if (title.startsWith("mcp__")) return split({ toolName: title });
  const m = CODEX_TITLE.exec(title);
  if (m) return { server: m[1], tool: m[2], raw: title };
  const input = call.rawInput as { server?: unknown; tool?: unknown } | null | undefined;
  if (title.startsWith("mcp.") && input && typeof input.server === "string" && typeof input.tool === "string" && input.server && input.tool) {
    return { server: input.server, tool: input.tool, raw: title };
  }
  return null;
}

const words = (s: string) => s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The readable label of an MCP tool call, or null when the call is not one. */
export function mcpToolLabel(call: CallLike): McpLabel | null {
  const parts = split(call);
  if (!parts) return null;
  const serverKey = parts.server.replace(/^claude_ai_/, "");
  const server = capital(words(serverKey));
  // `notion-search` on server Notion reads "Search".
  const lowered = serverKey.toLowerCase();
  let tool = parts.tool;
  const lt = tool.toLowerCase();
  if (lt.startsWith(lowered) && /[-_]/.test(tool[lowered.length] ?? "") && tool.length > lowered.length + 1) tool = tool.slice(lowered.length + 1);
  return { server: server || parts.server, tool: capital(words(tool)) || parts.tool, raw: parts.raw };
}

/** A call's title as plain text: "Notion › Search" for an MCP tool, else its title, kind or the fallback. */
export function toolTitleText(call: CallLike & { kind?: string | null }, fallback: string): string {
  const mcp = mcpToolLabel(call);
  if (mcp) return `${mcp.server} › ${mcp.tool}`;
  return call.title || call.kind || fallback;
}
