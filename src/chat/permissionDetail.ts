import type { ChatToolCall } from "./chatTypes";

/** What a permission request is about, beyond its title: the command, the URL, the paths or the agent's text.
 * Codex's titles are generic ("Run command", "Edit files"); the specifics sit in `rawInput`, `locations` and `content`.
 * Null when there is nothing the title doesn't already say. */
export function permissionDetail(call: ChatToolCall | null | undefined): string | null {
  if (!call) return null;
  const input = call.rawInput && typeof call.rawInput === "object" ? (call.rawInput as Record<string, unknown>) : {};
  const title = (call.title ?? "").trim();
  const keep = (text: string | null | undefined) => {
    const t = (text ?? "").trim();
    return t !== "" && t !== title && !title.includes(t) ? t : null;
  };
  const command = Array.isArray(input.command) ? input.command.filter((c) => typeof c === "string").join(" ") : input.command;
  if (typeof command === "string" && keep(command)) return keep(command);
  if (typeof input.url === "string" && keep(input.url)) return keep(input.url);
  const paths = [...new Set([...(call.locations ?? []).map((l) => l.path), ...(call.content ?? []).flatMap((c) => (c.type === "diff" ? [c.path] : []))])];
  const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : null;
  if (paths.length === 0 && filePath) paths.push(filePath);
  if (paths.length > 0) return keep(paths.join("\n"));
  const text = (call.content ?? []).map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : "")).filter(Boolean).join("\n");
  return keep(text);
}
