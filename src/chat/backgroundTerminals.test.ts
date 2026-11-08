import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chatModel";
import { backgroundTerminals } from "./backgroundTerminals";

const tool = (id: string, call: Record<string, unknown>): ChatItem => ({ type: "tool", id, call: { toolCallId: id, ...call } }) as ChatItem;
const result = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const launch = (id: string, shell: string, extra: Record<string, unknown> = {}) =>
  tool(id, { toolName: "Bash", kind: "execute", status: "completed", rawInput: { command: `cmd-${id}`, description: "d", run_in_background: true }, content: result(`Command running in background with ID: ${shell}. Output is being written to: x`), ...extra });

describe("backgroundTerminals", () => {
  it("lists background launches and ignores foreground commands", () => {
    const items = [launch("a", "sh1"), tool("b", { toolName: "Bash", rawInput: { command: "ls" }, status: "completed" })];
    const list = backgroundTerminals(items, "claude");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "a", shellId: "sh1", command: "cmd-a", running: true });
  });

  it("keeps the output the agent last read and ends on a finished status", () => {
    const items = [
      launch("a", "sh1"),
      tool("r1", { toolName: "BashOutput", rawInput: { bash_id: "sh1" }, status: "completed", content: result("<status>running</status>\n<stdout>ready</stdout>") }),
    ];
    expect(backgroundTerminals(items, "claude")[0]).toMatchObject({ running: true, output: "running\nready" });
    items.push(tool("r2", { toolName: "BashOutput", rawInput: { bash_id: "sh1" }, status: "completed", content: result("<status>completed</status><exit_code>0</exit_code>") }));
    expect(backgroundTerminals(items, "claude")[0].running).toBe(false);
  });

  it("ends on a kill and on a completion notice", () => {
    const killed = [launch("a", "sh1"), tool("k", { toolName: "KillShell", rawInput: { shell_id: "sh1" }, status: "completed" })];
    expect(backgroundTerminals(killed, "claude")[0].running).toBe(false);
    const notified = [launch("a", "sh1"), { type: "user", id: "u", text: "<task-notification><task-id>sh1</task-id><status>completed</status></task-notification>" } as ChatItem];
    expect(backgroundTerminals(notified, "claude")[0].running).toBe(false);
  });

  it("marks a subagent's terminal with its owner and drops a failed launch", () => {
    const list = backgroundTerminals([launch("a", "sh1", { parentToolUseId: "sub" }), launch("b", "sh2", { status: "failed" })], "claude");
    expect(list[0].ownerId).toBe("sub");
    expect(list[1].running).toBe(false);
  });
});

describe("backgroundTerminals for the other agents", () => {
  it("Gemini: is_background launches, the PID names the shell", () => {
    const items = [tool("g", { toolName: "run_shell_command", kind: "execute", status: "completed", rawInput: { command: "npm start", is_background: true }, content: result("Command moved to background (PID: 4242).") })];
    expect(backgroundTerminals(items, "gemini")[0]).toMatchObject({ command: "npm start", shellId: "4242", running: true });
  });

  it("Vibe: background bash, output reads and a kill", () => {
    const items = [
      tool("v", { kind: "execute", status: "completed", rawInput: { command: "sleep 99", background: true }, content: result("session_id: bash_ab12\nstatus: running") }),
      tool("o", { rawInput: { session_id: "bash_ab12" }, status: "completed", content: result("status: running\nhello") }),
    ];
    expect(backgroundTerminals(items, "vibe")[0]).toMatchObject({ shellId: "bash_ab12", running: true });
    items.push(tool("k", { rawInput: { action: "kill", session_id: "bash_ab12" }, status: "completed" }));
    expect(backgroundTerminals(items, "vibe")[0].running).toBe(false);
    expect(backgroundTerminals(items.slice(0, 1), "claude")).toHaveLength(0);
  });

  it("OpenCode: background shell or one moved there mid-run, the shell ID names it", () => {
    const moved = "Command moved to the background (shell ID: sh_7). Output is streaming to: /tmp/x";
    const items = [
      tool("a", { toolName: "shell", kind: "execute", status: "completed", rawInput: { command: "npm run dev", background: true }, content: result(moved) }),
      tool("b", { toolName: "shell", kind: "execute", status: "completed", rawInput: { command: "make" }, content: result(moved.replace("sh_7", "sh_8")) }),
      tool("c", { toolName: "shell", kind: "execute", status: "completed", rawInput: { command: "ls" }, content: result("a b") }),
    ];
    const list = backgroundTerminals(items, "opencode");
    expect(list.map((t) => t.shellId)).toEqual(["sh_7", "sh_8"]);
    expect(list[0]).toMatchObject({ command: "npm run dev", running: true });
  });

  it("Codex: a command call left open once the agent moved on is a background terminal", () => {
    const run = tool("c", { kind: "execute", status: "in_progress", title: "npm run dev" });
    const talk = { type: "agent", id: "a", text: "Server started" } as ChatItem;
    expect(backgroundTerminals([run], "codex")).toHaveLength(0);
    expect(backgroundTerminals([run, talk], "codex")[0]).toMatchObject({ command: "npm run dev", running: true });
    const done = tool("c", { kind: "execute", status: "completed", title: "npm run dev" });
    expect(backgroundTerminals([done, talk], "codex")).toHaveLength(0);
    expect(backgroundTerminals([run, talk], "claude")).toHaveLength(0);
  });
});
