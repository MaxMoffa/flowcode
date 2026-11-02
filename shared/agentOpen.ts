import type { ChatEvent } from "../src/chat/chatTypes";

const PREVIEWABLE = new Set(["html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm"]);

export function isPreviewableFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && !/[\\/]/.test(path.slice(dot)) && PREVIEWABLE.has(path.slice(dot + 1).toLowerCase());
}

// An opener must be a command, not a word inside an argument or commit message.
const OPENER_RE = /(?:^|[;&|(\n]|-(?:Command|c|lc)\s+["'])\s*(?:cmd(?:\.exe)?\s+\/c\s+)?(?:sudo\s+)?(?:start|open|xdg-open|wslview|explorer(?:\.exe)?|Start-Process|Invoke-Item|ii|python3?\s+-m\s+webbrowser|(?:google-chrome|chrome|msedge|firefox)(?:\.exe)?)\s+([^;&|\r\n]+)/gi;
const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
const CD_RE = /^\s*cd\s+(?:\/d\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;)/;

export function commandCwd(command: string, cwd: string): string {
  const match = command.match(CD_RE);
  const dir = match && (match[1] ?? match[2] ?? match[3]);
  if (!dir || dir === "~" || dir.startsWith("~/") || dir.startsWith("$")) return cwd;
  if (dir.startsWith("/") || /^[a-z]:[\\/]/i.test(dir)) return dir;
  return `${cwd.replace(/[\\/]+$/, "")}/${dir}`;
}

function fileTarget(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, "");
    return url.hostname && url.hostname !== "localhost" ? `//${url.hostname}${path}` : path;
  } catch { return value; }
}

/** The previewable target of a system opener, shared by desktop and mobile. */
export function openCommandTarget(command: string): string | null {
  for (const match of command.matchAll(OPENER_RE)) {
    for (const token of match[1].matchAll(TOKEN_RE)) {
      const value = token[1] ?? token[2] ?? token[3] ?? "";
      if (!value || value.startsWith("-") || /^\/[a-z]$/i.test(value)) continue;
      if (/^https?:\/\//i.test(value)) return value;
      const path = fileTarget(value);
      if (isPreviewableFile(path)) return path;
    }
  }
  return null;
}

/** Shell tool inputs from Claude, Codex and other ACP adapters. */
export function toolCommand(update: Record<string, unknown>): string | null {
  const input = update.rawInput;
  if (!input || typeof input !== "object") return null;
  const { command, cmd } = input as { command?: unknown; cmd?: unknown };
  return typeof command === "string" ? command : typeof cmd === "string" ? cmd : null;
}

/** Tracks partial tool updates; only a successful live opener causes navigation. */
export function createAgentOpenTracker(cwd: string) {
  const commands = new Map<string, string>();
  const settled = new Set<string>();
  return (event: ChatEvent, replay = false): { target: string; cwd: string } | null => {
    if (event.kind !== "update") return null;
    const update = event.update;
    const id = update.toolCallId;
    if ((update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") || typeof id !== "string" || settled.has(id)) return null;
    const command = toolCommand(update) ?? commands.get(id);
    if (update.status !== "completed" && update.status !== "failed") {
      if (command) commands.set(id, command);
      return null;
    }
    commands.delete(id);
    settled.add(id);
    if (replay || update.status === "failed" || !command) return null;
    const target = openCommandTarget(command);
    return target ? { target, cwd: commandCwd(command, cwd) } : null;
  };
}
