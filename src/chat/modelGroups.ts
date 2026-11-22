import type { ChatModelOption } from "./chatTypes";
import { splitModelVersions } from "./modelVersions";

/** Fewer models than this: no grouping, no search. */
export const GROUP_MIN = 8;

interface ModelGroup {
  key: string;
  label: string;
  latest: ChatModelOption[];
  older: ChatModelOption[];
}

export interface GroupedModels {
  groups: ModelGroup[];
  /** modelId → name shown inside its group (prefix stripped). */
  names: Map<string, string>;
  /** modelId → group label. */
  groupOf: Map<string, string>;
}

/** Splits "Provider/Model" at the first slash; null when either side is empty. */
function splitPrefix(name: string): { label: string; rest: string } | null {
  const at = name.indexOf("/");
  if (at < 0) return null;
  const label = name.slice(0, at).trim();
  const rest = name.slice(at + 1).trim();
  return label && rest ? { label, rest } : null;
}

/**
 * Groups a long model list by the agent's own `group`, or failing that by the
 * "Provider/" prefix of the names. Null when the list is short or not groupable.
 */
export function groupModels(models: ChatModelOption[]): GroupedModels | null {
  if (models.length < GROUP_MIN) return null;
  const entries: { m: ChatModelOption; label: string; shown: string }[] = [];
  if (models.every((m) => !!m.group && m.group.trim() !== "")) {
    for (const m of models) entries.push({ m, label: m.group as string, shown: m.name });
  } else {
    for (const m of models) {
      const p = splitPrefix(m.name);
      if (!p) return null;
      entries.push({ m, label: p.label, shown: p.rest });
    }
  }
  const buckets = new Map<string, { label: string; members: ChatModelOption[] }>();
  const names = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const { m, label, shown } of entries) {
    const key = label.toLowerCase();
    let b = buckets.get(key);
    if (!b) {
      b = { label, members: [] };
      buckets.set(key, b);
    }
    b.members.push(m);
    names.set(m.modelId, shown);
    groupOf.set(m.modelId, b.label);
  }
  if (buckets.size < 2) return null;
  const groups: ModelGroup[] = Array.from(buckets, ([key, b]) => ({ key, label: b.label, ...splitModelVersions(b.members) }));
  return { groups, names, groupOf };
}

/** Every whitespace-separated term of the query must appear in the model's text. */
export function matchesModel(m: ChatModelOption, query: string, groupLabel?: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${m.name} ${m.modelId} ${m.description ?? ""} ${groupLabel ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
