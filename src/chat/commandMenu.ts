import type { ChatCommand } from "./chatTypes";

/** What a "/" entry is: ours, an agent built-in, a user skill, a plugin skill or an MCP prompt. */
export type CommandKind = "flowcode" | "command" | "skill" | "plugin" | "mcp";

export interface MenuEntry {
  command: ChatCommand;
  kind: CommandKind;
  namespace: string | null;
  /** The name without namespace and sigil. */
  base: string;
  sigil: "" | "$";
  hint: string | null;
  /** Namespaces of plugin copies folded into this skill. */
  also: string[];
}

export const KIND_ORDER: CommandKind[] = ["flowcode", "command", "skill", "plugin", "mcp"];

/** Built-ins of Claude Code and Codex: the agents don't say which commands are theirs, skills look the same. */
const AGENT_COMMANDS = new Set([
  "add-dir", "agents", "approvals", "bug", "compact", "config", "context", "cost", "debug", "diff", "doctor", "export",
  "feedback", "goal", "help", "hooks", "init", "logout", "mcp", "memory", "mention", "model", "new", "permissions", "plan",
  "quit", "release-notes", "rename", "resume", "review", "review-branch", "review-commit", "rewind", "security-review",
  "skills", "status", "statusline", "todos", "undo", "usage", "vim",
]);

const MAX_ENTRIES = 300;

export function classify(command: ChatCommand, clientNames: Set<string>): MenuEntry {
  const input = command.input;
  const hint =
    input && typeof input === "object" && typeof (input as { hint?: unknown }).hint === "string"
      ? (input as { hint: string }).hint
      : null;
  const entry: MenuEntry = { command, kind: "skill", namespace: null, base: command.name, sigil: "", hint, also: [] };
  if (clientNames.has(command.name)) return { ...entry, kind: "flowcode" };
  let name = command.name;
  if (name.startsWith("mcp:")) {
    const parts = name.slice(4).split(":");
    return parts.length > 1
      ? { ...entry, kind: "mcp", namespace: parts[0], base: parts.slice(1).join(":") }
      : { ...entry, kind: "mcp", base: parts[0] };
  }
  const sigil = name.startsWith("$") ? "$" : "";
  if (sigil) name = name.slice(1);
  entry.sigil = sigil;
  const colon = name.indexOf(":");
  if (colon > 0) return { ...entry, kind: "plugin", namespace: name.slice(0, colon), base: name.slice(colon + 1) };
  entry.base = name;
  // A "$" skill is never a built-in; Codex's own commands carry no sigil.
  entry.kind = !sigil && AGENT_COMMANDS.has(name) ? "command" : "skill";
  return entry;
}

/** Plugin skills duplicating a user skill of the same name fold into it. */
export function dedupe(entries: MenuEntry[]): MenuEntry[] {
  const skills = new Map<string, MenuEntry>();
  for (const e of entries) if (e.kind === "skill") skills.set(e.base, e);
  const out: MenuEntry[] = [];
  for (const e of entries) {
    const twin = e.kind === "plugin" ? skills.get(e.base) : undefined;
    if (twin && e.namespace) twin.also.push(e.namespace);
    else out.push(e);
  }
  return out;
}

export function displayName(entry: MenuEntry): string {
  return (entry.namespace ? entry.namespace + ":" : "") + entry.base;
}

const range = (start: number, n: number) => Array.from({ length: n }, (_, i) => start + i);

/** Fuzzy score: base prefix > word start > substring > subsequence > description; `hits` index the display name. */
export function match(entry: MenuEntry, query: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/^\$/, "");
  if (!q) return { score: 1, hits: [] };
  const target = displayName(entry).toLowerCase();
  const base = entry.base.toLowerCase();
  const offset = entry.namespace ? entry.namespace.length + 1 : 0;
  let i = base.indexOf(q);
  if (i === 0) return { score: 100 - base.length / 100, hits: range(offset, q.length) };
  if (i > 0 && /[-_:]/.test(base[i - 1])) return { score: 80, hits: range(offset + i, q.length) };
  i = target.indexOf(q);
  if (i >= 0) return { score: 60, hits: range(i, q.length) };
  const hits: number[] = [];
  let k = 0;
  for (let j = 0; j < target.length && k < q.length; j++) {
    if (target[j] === q[k]) {
      hits.push(j);
      k++;
    }
  }
  if (k === q.length) return { score: 40 - (hits[hits.length - 1] - hits[0]) / 10, hits };
  if ((entry.command.description ?? "").toLowerCase().includes(q)) return { score: 10, hits: [] };
  return null;
}

export interface MenuResult {
  entries: Array<{ entry: MenuEntry; hits: number[] }>;
  /** Empty query: listed by kind, otherwise ranked. */
  grouped: boolean;
}

export function buildMenu(commands: ChatCommand[], clientCommands: ChatCommand[], query: string): MenuResult {
  const clientNames = new Set(clientCommands.map((c) => c.name));
  const all = [...clientCommands, ...commands.filter((c) => !clientNames.has(c.name))];
  const entries = dedupe(all.map((c) => classify(c, clientNames)));
  const matched = entries.flatMap((entry) => {
    const m = match(entry, query);
    return m ? [{ entry, hits: m.hits, score: m.score }] : [];
  });
  const grouped = query.replace(/^\$/, "") === "";
  if (grouped) {
    matched.sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.entry.kind) - KIND_ORDER.indexOf(b.entry.kind) ||
        displayName(a.entry).localeCompare(displayName(b.entry)),
    );
  } else {
    matched.sort((a, b) => b.score - a.score);
  }
  return { entries: matched.slice(0, MAX_ENTRIES).map(({ entry, hits }) => ({ entry, hits })), grouped };
}

/** What goes to the agent: codex-acp treats "/$x" as a plain prompt, and Codex resolves "$skill" mentions itself. */
export function commandText(entry: MenuEntry): string {
  return entry.sigil === "$" ? `$${entry.command.name.replace(/^\$/, "")}` : `/${entry.command.name}`;
}
