import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/chat/chatTypes";
import { agentCallOf, createAgentOpenTracker, openCommandTarget, toolCommand } from "./agentOpen";

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
  it("does not sniff Flowcode's own tool: the app sends `_flowcode/open` for it", () => {
    const meta = { claudeCode: { toolName: "mcp__flowcode__open_in_browser" } };
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ _meta: meta, rawInput: { target: "https://example.com" } }))).toBeNull();
    expect(track(event({ _meta: meta, status: "completed" }))).toBeNull();
  });
  it("routes Flowcode's `_flowcode/open` event directly, live only", () => {
    const track = createAgentOpenTracker("/repo");
    const ext: ChatEvent = { kind: "ext", seq: 3, at: 0, method: "_flowcode/open", params: { target: "https://example.com", cwd: "/repo/docs" } };
    expect(track(ext, true)).toBeNull();
    expect(track(ext)).toEqual({ target: "https://example.com", cwd: "/repo/docs", direct: true });
    expect(track({ ...ext, params: { target: "" } })).toBeNull();
    expect(track({ ...ext, params: { target: "a.html" } })).toEqual({ target: "a.html", cwd: "/repo", direct: true });
  });
  it("can finish a command whose start arrived in the reconnect replay", () => {
    const track = createAgentOpenTracker("/repo");
    expect(track(event({ status: "in_progress", rawInput: { command: "xdg-open http://localhost:5173" } }), true)).toBeNull();
    expect(track(event({ status: "completed" }))).toEqual({ target: "http://localhost:5173", cwd: "/repo" });
  });
});

describe("agentCallOf", () => {
  const ext = (params: unknown, method = "_flowcode/call"): ChatEvent => ({ kind: "ext", seq: 1, at: 0, method, params });
  it("reads a live call_user event", () => {
    expect(agentCallOf(ext({ message: " Ready to review ", reason: "review" }))).toEqual({ message: "Ready to review", reason: "review" });
    expect(agentCallOf(ext({ message: "hi", reason: "weird" }))).toEqual({ message: "hi", reason: "info" });
  });
  it("ignores replays, empty messages and other events", () => {
    expect(agentCallOf(ext({ message: "hi" }), true)).toBeNull();
    expect(agentCallOf(ext({ message: "  " }))).toBeNull();
    expect(agentCallOf(ext({ message: "hi" }, "_flowcode/open"))).toBeNull();
  });
});
