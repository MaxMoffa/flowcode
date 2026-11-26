import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The MCP script agents launch (`src-tauri/src/flowcode-mcp.cjs`): it offers only the tools Flowcode listed.
const SCRIPT = fileURLToPath(new URL("../../src-tauri/src/flowcode-mcp.cjs", import.meta.url));

function listTools(enabled: string): { name: string; inputSchema: { required?: string[] } }[] {
  const run = spawnSync(process.execPath, [SCRIPT], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    env: { ...process.env, FLOWCODE_MCP_TOOLS: enabled },
    encoding: "utf8",
    timeout: 10_000,
  });
  const line = run.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  return JSON.parse(line ?? "{}").result.tools;
}

describe("flowcode-mcp.cjs", () => {
  it("offers the message tools only when they are listed", () => {
    expect(listTools("open_in_browser").map((t) => t.name)).toEqual(["open_in_browser"]);
    const tools = listTools("list_agents,send_message,wait_for_reply,read_messages");
    expect(tools.map((t) => t.name)).toEqual(["list_agents", "send_message", "wait_for_reply", "read_messages"]);
    expect(tools.find((t) => t.name === "send_message")?.inputSchema.required).toEqual(["to", "text"]);
    expect(tools.find((t) => t.name === "wait_for_reply")?.inputSchema.required).toEqual(["message_id"]);
  });
});
