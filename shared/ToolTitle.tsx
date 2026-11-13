import { mcpToolLabel } from "../src/chat/mcpToolLabel";

/** A tool step's title. An MCP tool reads as a breadcrumb: a monogram, the server (muted), › and the tool; the raw name stays in the tooltip. */
export function ToolTitle({ call, fallback }: { call: { toolName?: string; title?: string | null; kind?: string | null; rawInput?: unknown }; fallback: string }) {
  const mcp = mcpToolLabel(call);
  if (!mcp) return <span className="chat-step-title">{call.title || call.kind || fallback}</span>;
  return (
    <span className="chat-mcp" title={mcp.raw}>
      <span className={`chat-mcp-ic${mcp.server.toLowerCase() === "flowcode" ? " is-flowcode" : ""}`} aria-hidden="true">
        {mcp.server[0]?.toUpperCase()}
      </span>
      <span className="chat-mcp-srv">{mcp.server}</span>
      <span className="chat-mcp-sep" aria-hidden="true">›</span>
      <span className="chat-step-title">{mcp.tool}</span>
    </span>
  );
}
