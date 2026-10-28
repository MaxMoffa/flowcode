import type { ChatModelOption } from "./chatTypes";

const DATE = /(?<!\d)\d{8}(?!\d)/g;
// First number group: "4", "4.5", or "4-5" (a dash between single digits reads as a dot).
const VERSION = /\d+(?:\.\d+|-\d(?!\d))*/;

interface Parsed {
  version: number[] | null;
  family: string;
}

function parseOne(source: string): Parsed {
  const clean = source.toLowerCase().replace(DATE, " ");
  const m = VERSION.exec(clean);
  if (!m) return { version: null, family: normalize(clean) };
  const version = m[0].split(/[.-]/).map(Number);
  const rest = clean.slice(0, m.index) + " " + clean.slice(m.index + m[0].length);
  return { version, family: normalize(rest) };
}

function normalize(s: string): string {
  return s
    .replace(/[\s_-](preview|exp|experimental|beta)\b/g, "")
    .replace(/[\s_]+/g, " ")
    .replace(/\s*([-/])\s*/g, "$1")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s\-_/]+|[\s\-_/]+$/g, "")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/** The model's version and family, from its display name or, failing that, its id. */
function parse(m: ChatModelOption): Parsed {
  const byName = parseOne(m.name);
  if (byName.version) return byName;
  return parseOne(m.modelId);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Splits a model list into the newest model of each family and the older versions
 * of the same families ("Sonnet 4.5" over "Sonnet 4"). Entries without a version
 * are always latest; the order of the agent's list is kept inside each part.
 */
export function splitModelVersions(models: ChatModelOption[], _currentModelId: string): { latest: ChatModelOption[]; older: ChatModelOption[] } {
  const parsed = models.map(parse);
  const best = new Map<string, number[]>();
  for (const p of parsed) {
    if (!p.version) continue;
    const top = best.get(p.family);
    if (!top || compare(p.version, top) > 0) best.set(p.family, p.version);
  }
  const latest: ChatModelOption[] = [];
  const older: ChatModelOption[] = [];
  models.forEach((m, i) => {
    const p = parsed[i];
    const top = p.version ? best.get(p.family) : undefined;
    if (p.version && top && compare(p.version, top) < 0) older.push(m);
    else latest.push(m);
  });
  return { latest, older };
}
