import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/chat/chatTypes";
import { createAgentOpenTracker, openCommandTarget, toolCommand } from "./agentOpen";

const event = (patch: Record<string, unknown>): ChatEvent => ({
  kind: "update", seq: 1, at: 0,
  update: { sessionUpdate: "tool_call_update", toolCallId: "open-1", ...patch },
});

describe("agent preview openers", () => {
  it("recognizes Codex and Claude shell inputs", () => {
    expect(toolCommand({ rawInput: { cmd: "open index.html" } })).toBe("open index.html");
    expect(toolCommand({ rawInput: { command: "open index.html" } })).toBe("open index.html");
    expect(toolCommand({ rawInput: "open index.html" })).toBeNull();
  });
  it("decodes a Windows browser file URL instead of treating it as a phone URL", () => {
    expect(openCommandTarget('Start-Process -FilePath "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList "file:///C:/repo/my%20report.html"'))
      .toBe("C:/repo/my report.html");
    expect(openCommandTarget('open "file:///home/me/report.html"')).toBe("/home/me/report.html");
  });
  it("waits for a successful completion and retains input from earlier updates", () => {
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ status: "in_progress", rawInput: { cmd: "cd docs; open report.html" } }))).toBeNull();
    expect(track(event({ status: "completed" }))).toEqual({ target: "report.html", cwd: "/repo/docs" });
    expect(track(event({ status: "completed" }))).toBeNull();
  });
  it("never navigates on failed, denied, non-opener or message events", () => {
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ status: "failed", rawInput: { command: "open report.html" } }))).toBeNull();
    expect(track(event({ status: "completed" }))).toBeNull();
    expect(createAgentOpenTracker("/repo")(event({ status: "completed", rawInput: { cmd: "cat report.html" } }))).toBeNull();
    expect(track({ kind: "user", text: "open report.html", seq: 2, at: 0 })).toBeNull();
  });
  it("never reopens history, including a duplicate after reconnect", () => {
    const track = createAgentOpenTracker("/repo");
    const done = event({ status: "completed", rawInput: { command: "open report.html" } });
    expect(track(done, true)).toBeNull();
    expect(track(done, false)).toBeNull();
  });
  it("follows Flowcode's own tool, marked as not opened yet", () => {
    const meta = { claudeCode: { toolName: "mcp__flowcode__open_in_browser" } };
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ _meta: meta, rawInput: { target: "https://example.com" } }))).toBeNull();
    expect(track(event({ _meta: meta, status: "completed" }))).toEqual({ target: "https://example.com", cwd: "/repo", direct: true });
  });
  it("ignores Flowcode's tool when denied, or for a target it can't preview", () => {
    const meta = { claudeCode: { toolName: "mcp__flowcode__open_in_browser" } };
    expect(createAgentOpenTracker("/repo")(event({ _meta: meta, status: "failed", rawInput: { target: "https://example.com" } }))).toBeNull();
    expect(createAgentOpenTracker("/repo")(event({ _meta: meta, status: "completed", rawInput: { target: "C:/Windows/calc.exe" } }))).toBeNull();
    expect(createAgentOpenTracker("/repo")(event({ _meta: meta, status: "completed", rawInput: { target: "javascript:alert(1)" } }))).toBeNull();
  });
  it("needs the tool's exact name, not just a target input", () => {
    expect(createAgentOpenTracker("/repo")(event({ _meta: { claudeCode: { toolName: "mcp__other__open" } }, status: "completed", rawInput: { target: "https://example.com" } }))).toBeNull();
  });
  it("can finish a command whose start arrived in the reconnect replay", () => {
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ status: "in_progress", rawInput: { command: "xdg-open http://localhost:5173" } }), true)).toBeNull();
    expect(track(event({ status: "completed" }))).toEqual({ target: "http://localhost:5173", cwd: "/repo" });
  });
});
