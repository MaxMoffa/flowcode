import type { ChatItem } from "./chatModel";
import type { ChatToolCall } from "./chatTypes";

/** A command the agent started in the background. */
export interface BackgroundTerminal {
  /** The launching tool call's id. */
  id: string;
  /** The id the agent knows it by (its output reads and kills address it), once the launch result named it. */
  shellId: string | null;
  command: string;
  /** What the agent said it is for. */
  description: string;
  /** The launch call's `parentToolUseId`: set when a subagent started it. */
  ownerId: string | null;
  running: boolean;
  /** Latest output the agent read; empty until it polls. */
  output: string;
  /** When the launch call first appeared (event time, ms); null for history replayed without it. */
  startedAt: number | null;
}

const input = (call: ChatToolCall): Record<string, unknown> => (call.rawInput && typeof call.rawInput === "object" ? (call.rawInput as Record<string, unknown>) : {});

const text = (call: ChatToolCall): string =>
  (call.content ?? [])
    .map((c) => (c.type === "content" && typeof c.content.text === "string" ? c.content.text : ""))
    .filter(Boolean)
    .join("\n");

const ENDED = new Set(["completed", "failed", "killed", "cancelled", "stopped", "exited", "error", "timed_out", "orphaned"]);
const OPEN = (call: ChatToolCall) => call.status === "in_progress" || call.status === "pending" || call.status === undefined;

/** How each agent says a command runs in the background (none of them reports it as a terminal: the client has no terminal capability). */
function launchOf(call: ChatToolCall, agent: string): { command: string; shell: RegExp | null } | null {
  const i = input(call);
  const command = typeof i.command === "string" ? i.command : null;
  if (!command) return null;
  // Claude's Bash: "Command running in background with ID: x".
  if (i.run_in_background === true) return { command, shell: /background with ID:\s*([A-Za-z0-9_-]+)/ };
  // Gemini's run_shell_command: "... moved to background (PID: 123)".
  if (i.is_background === true) return { command, shell: /PID:\s*(\d+)/ };
  // Vibe's managed bash: the result carries `session_id`.
  if (agent === "vibe" && i.background === true) return { command, shell: /session_id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/ };
  // OpenCode's shell: `background: true`, or a foreground command moved there mid-run;
  // both finish with "Command moved to the background (shell ID: x)".
  if (agent === "opencode" && (i.background === true || /moved to the background \(shell ID:/.test(text(call))))
    return { command, shell: /shell ID:\s*([A-Za-z0-9_-]+)/ };
  return null;
}

/** Which background shell a later output read / kill call addresses. */
function targetOf(call: ChatToolCall): string | null {
  const i = input(call);
  const id = i.bash_id ?? i.shell_id ?? i.shellID ?? i.task_id ?? i.session_id ?? i.pid;
  return typeof id === "string" && id !== "" ? id : typeof id === "number" ? String(id) : null;
}

/** The state an output read or a notification reports, if it says one. */
function statusIn(body: string): string | null {
  const m = /<status>\s*([a-z_]+)\s*<\/status>/i.exec(body) ?? /["']?status["']?\s*[:=]\s*["']?([a-z_]+)/i.exec(body);
  return m ? m[1].toLowerCase() : null;
}

/** Whether a call asks to stop a background shell. */
function isKill(call: ChatToolCall): boolean {
  const name = (call.toolName ?? "").toLowerCase();
  return name === "killshell" || name === "taskstop" || input(call).action === "kill";
}

/**
 * The agent's background commands, oldest first, with whether each still runs as far as the conversation shows.
 * Claude, Gemini and Vibe flag the launch in the call's input. Codex doesn't: its unified exec keeps the command's
 * call open while the process lives, so a command call still open once the agent has moved on is a background one.
 */
export function backgroundTerminals(items: ChatItem[], agent: string): BackgroundTerminal[] {
  const terminals: BackgroundTerminal[] = [];
  const shells = new Map<string, RegExp | null>();
  const make = (id: string, call: ChatToolCall, command: string): BackgroundTerminal => {
    const i = input(call);
    return {
      id,
      shellId: null,
      command,
      description: typeof i.description === "string" ? i.description : "",
      ownerId: call.parentToolUseId ?? null,
      // A launch that failed never started.
      running: call.status !== "failed",
      output: "",
      startedAt: call.startedAt ?? null,
    };
  };
  items.forEach((item, index) => {
    if (item.type !== "tool") return;
    const launch = launchOf(item.call, agent);
    if (launch) {
      terminals.push(make(item.id, item.call, launch.command));
      shells.set(item.id, launch.shell);
    } else if (agent === "codex" && item.call.kind === "execute" && OPEN(item.call) && typeof item.call.title === "string" && item.call.title !== "") {
      // Anything after the call (the agent talking, another tool) means it did not wait for it.
      const moved = items.slice(index + 1).some((later) => later.type === "agent" || (later.type === "tool" && later.call.parentToolUseId === undefined));
      if (moved) terminals.push(make(item.id, item.call, item.call.title));
    }
  });
  // In order: launch results name the shells, then output reads, kills and notices update them.
  const byShell = new Map<string, BackgroundTerminal>();
  for (const item of items) {
    if (item.type === "tool") {
      const term = terminals.find((t) => t.id === item.id);
      const pattern = term ? shells.get(term.id) : null;
      if (term && pattern && !term.shellId) {
        const m = pattern.exec(text(item.call));
        if (m) {
          term.shellId = m[1];
          byShell.set(m[1], term);
        }
        continue;
      }
      if (term) {
        // A Codex command (no launch marker): it ends with its own call.
        if (!shells.has(term.id) && !OPEN(item.call)) term.running = false;
        continue;
      }
      const target = targetOf(item.call);
      const hit = target ? byShell.get(target) : undefined;
      if (!hit) continue;
      if (isKill(item.call)) {
        if (item.call.status === "completed") hit.running = false;
        continue;
      }
      const body = text(item.call);
      if (body) hit.output = body.replace(/<\/?(?:status|exit_code|stdout|stderr|timestamp|retrieval_status|task_id|task_type|output)>/gi, "").trim();
      const status = statusIn(body);
      if (status && ENDED.has(status)) hit.running = false;
    } else if (item.type === "user") {
      // Claude's completion notices come back as a message: <task-notification><task-id>…</task-id><status>completed</status>…
      for (const m of item.text.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>[\s\S]*?<status>\s*([a-z_]+)\s*<\/status>/gi)) {
        const hit = byShell.get(m[1]);
        if (hit && ENDED.has(m[2].toLowerCase())) hit.running = false;
      }
    }
  }
  return terminals;
}
