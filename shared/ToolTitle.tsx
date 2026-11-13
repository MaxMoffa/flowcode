import { mcpToolLabel } from "../src/chat/mcpToolLabel";
import { useMcpIcon } from "./mcpIcons";

/** A tool step's title. An MCP tool reads as a breadcrumb: a monogram (or the service's icon), the server (muted), › and the tool; the raw name stays in the tooltip. */
export function ToolTitle({ call, fallback }: { call: { toolName?: string; title?: string | null; kind?: string | null; rawInput?: unknown }; fallback: string }) {
  const mcp = mcpToolLabel(call);
  const icon = useMcpIcon(mcp?.serverKey);
  if (!mcp) return <span className="chat-step-title">{call.title || call.kind || fallback}</span>;
  return (
    <span className="chat-mcp" title={mcp.raw}>
      <span className={`chat-mcp-ic${icon ? " has-img" : ""}${mcp.server.toLowerCase() === "flowcode" ? " is-flowcode" : ""}`} aria-hidden="true">
        {icon ? <img src={icon} alt="" draggable={false} /> : mcp.server[0]?.toUpperCase()}
      </span>
      <span className="chat-mcp-srv">{mcp.server}</span>
      <span className="chat-mcp-sep" aria-hidden="true">›</span>
      <span className="chat-step-title">{mcp.tool}</span>
    </span>
  );
}
