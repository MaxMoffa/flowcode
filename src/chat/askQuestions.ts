// Pure helpers for the agent's questions (AskUserQuestion). No imports: the phone uses this module too.

export interface AskOption {
  label: string;
  /** Original wire value when it differs from the display label. */
  value?: string;
  description?: string;
  /** The agent marked it "(Recommended)". */
  recommended: boolean;
}

export interface AskQuestion {
  /** Original property name in the form schema. */
  key: string;
  /** Free-text property; null forbids custom answers. Absent on legacy questions: `${key}_custom`. */
  customKey?: string | null;
  header?: string;
  text: string;
  multi: boolean;
  options: AskOption[];
}

const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionsOf(list: unknown): AskOption[] {
  if (!Array.isArray(list)) return [];
  const out: AskOption[] = [];
  for (const o of list) {
    if (!isRecord(o)) continue;
    const value = typeof o.const === "string" ? o.const : null;
    const raw = typeof o.title === "string" && o.title ? o.title : value;
    if (raw === null) continue;
    const label = raw.replace(RECOMMENDED, "");
    out.push({
      label,
      ...(value !== null && value !== label ? { value } : {}),
      ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
      recommended: RECOMMENDED.test(raw),
    });
  }
  return out;
}

/** The questions in an ACP form schema, in order. `message`: the question itself when there is exactly one (the schema then has no per-question text). */
export function parseAskQuestions(schema: unknown, message: string): AskQuestion[] {
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const found: AskQuestion[] = [];
  for (const [key, value] of Object.entries(props)) {
    const m = /^question_(\d+)$/.exec(key);
    if (!isRecord(value)) continue;
    // OpenCode calls its questions q0, q1, etc.; other ACP clients may use any key.
    if (key.endsWith("_custom")) {
      const base = props[key.slice(0, -7)];
      if (isRecord(base) && (Array.isArray(base.oneOf) || (isRecord(base.items) && Array.isArray(base.items.anyOf)))) continue;
    }
    if (value.type !== undefined && value.type !== "string" && value.type !== "array") continue;
    const multi = value.type === "array";
    const options = multi ? optionsOf(isRecord(value.items) ? value.items.anyOf : null) : optionsOf(value.oneOf);
    if (!m && !options.length && value.type !== "string") continue;
    const header = typeof value.title === "string" && value.title ? value.title : undefined;
    const desc = typeof value.description === "string" && value.description ? value.description : undefined;
    const custom = props[`${key}_custom`];
    const hasCustom = isRecord(custom) && custom.type === "string";
    found.push({ key, ...(header ? { header } : {}), text: desc ?? message, multi, options,
      ...(!options.length && !m ? { customKey: key } : !hasCustom && !m ? { customKey: null } : {}),
    });
  }
  // Claude's numbered questions historically sort numerically; arbitrary forms keep schema order.
  return found.every((q) => /^question_\d+$/.test(q.key))
    ? found.sort((a, b) => Number(a.key.slice(9)) - Number(b.key.slice(9)))
    : found;
}

/** One answer per question: the picked option indexes and the typed free text. */
export interface AskAnswer {
  picked: number[];
  custom: string;
}

/** Answers use the schema's original keys and values; custom answers stay separate when declared. */
export function buildAskContent(questions: AskQuestion[], answers: AskAnswer[]): Record<string, unknown> {
  const content: Record<string, unknown> = Object.create(null);
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    const labels = [...a.picked].sort((x, y) => x - y).map((p) => q.options[p]?.value ?? q.options[p]?.label).filter((l): l is string => typeof l === "string");
    if (q.multi) {
      if (labels.length) content[q.key] = labels;
    } else if (labels.length) {
      content[q.key] = labels[0];
    }
    const custom = a.custom.trim();
    if (custom && q.customKey !== null) content[q.customKey ?? `${q.key}_custom`] = custom;
  });
  return content;
}

/** A one-line reading of an answer, for the transcript. */
export function askSummary(questions: AskQuestion[], content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const q of questions) {
    const v = content[q.key];
    const values = Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
    const picked = values.map((value) => q.options.find((o) => (o.value ?? o.label) === value)?.label ?? value);
    const customKey = q.customKey === null ? null : q.customKey ?? `${q.key}_custom`;
    const custom = customKey !== null && customKey !== q.key ? content[customKey] : undefined;
    if (typeof custom === "string" && custom) picked.push(custom);
    if (picked.length) parts.push(picked.join(", "));
  }
  return parts.join(" · ");
}
