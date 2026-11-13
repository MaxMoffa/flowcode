import { describe, expect, it } from "vitest";
import { mcpToolLabel, toolTitleText } from "./mcpToolLabel";

describe("mcpToolLabel", () => {
  it("splits a Claude MCP tool name into a readable server and tool", () => {
    expect(mcpToolLabel({ toolName: "mcp__claude_ai_Notion__notion-search" })).toEqual({
      server: "Notion",
      serverKey: "claude_ai_Notion",
      tool: "Search",
      raw: "mcp__claude_ai_Notion__notion-search",
    });
    expect(mcpToolLabel({ toolName: "mcp__claude_ai_Claude_Docs__batch" })).toMatchObject({ server: "Claude Docs", tool: "Batch" });
    expect(mcpToolLabel({ toolName: "mcp__flowcode__open_in_browser" })).toMatchObject({ server: "Flowcode", tool: "Open in browser" });
    expect(mcpToolLabel({ toolName: "mcp__claude_ai_Gmail__send_message" })).toMatchObject({ server: "Gmail", tool: "Send message" });
  });

  it("reads a Codex mcp.<server>.<tool> title", () => {
    expect(mcpToolLabel({ title: "mcp.my_postgres.run_query" })).toEqual({
      server: "My postgres",
      serverKey: "my_postgres",
      tool: "Run query",
      raw: "mcp.my_postgres.run_query",
    });
  });

  it("reads an mcp__ name given as the title", () => {
    expect(mcpToolLabel({ title: "mcp__github__create_issue" })).toMatchObject({ server: "Github", tool: "Create issue" });
  });

  it("returns null for calls that are not MCP tools", () => {
    expect(mcpToolLabel({ toolName: "Read", title: "Read file" })).toBeNull();
    expect(mcpToolLabel({ toolName: "mcp__x" })).toBeNull();
    expect(mcpToolLabel({ title: "mcp.server" })).toBeNull();
  });
});

describe("toolTitleText", () => {
  it("shows an MCP tool as a breadcrumb", () => {
    expect(toolTitleText({ toolName: "mcp__claude_ai_Notion__notion-search" }, "x")).toBe("Notion › Search");
  });

  it("falls back to the kind, then the fallback", () => {
    expect(toolTitleText({ title: "", kind: "read" }, "x")).toBe("read");
    expect(toolTitleText({}, "x")).toBe("x");
  });
});
