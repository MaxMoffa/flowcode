// Pure helpers for the agent's questions (AskUserQuestion). No imports: the phone uses this module too.

export interface AskOption {
  label: string;
  /** Stable answer value when display labels are not unique (permission options). */
  value?: string;
  description?: string;
  /** The agent marked it "(Recommended)". */
  recommended: boolean;
}

export interface AskQuestion {
  /** Property name in the answer: `question_0`, ... (its free text goes under `${key}_custom`). */
  key: string;
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
    const raw = typeof o.const === "string" ? o.const : typeof o.title === "string" ? o.title : null;
    if (raw === null) continue;
    const label = raw.replace(RECOMMENDED, "");
    out.push({
      label,
      ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
      recommended: RECOMMENDED.test(raw),
    });
  }
  return out;
}

/** The questions in an ACP form schema, in order. `message`: the question itself when there is exactly one (the schema then has no per-question text). */
export function parseAskQuestions(schema: unknown, message: string): AskQuestion[] {
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const found: { n: number; q: AskQuestion }[] = [];
  for (const [key, value] of Object.entries(props)) {
    const m = /^question_(\d+)$/.exec(key);
    if (!m || !isRecord(value)) continue;
    const multi = value.type === "array";
    const options = multi ? optionsOf(isRecord(value.items) ? value.items.anyOf : null) : optionsOf(value.oneOf);
    const header = typeof value.title === "string" && value.title ? value.title : undefined;
    const desc = typeof value.description === "string" && value.description ? value.description : undefined;
    found.push({ n: Number(m[1]), q: { key, ...(header ? { header } : {}), text: desc ?? message, multi, options } });
  }
  return found.sort((a, b) => a.n - b.n).map((f) => f.q);
}

/** One answer per question: the picked option indexes and the typed free text. */
export interface AskAnswer {
  picked: number[];
  custom: string;
}

/** The accept payload: `question_N: label` (or a list of labels for a multi-select) and `question_N_custom` when typed; unanswered questions are left out. */
export function buildAskContent(questions: AskQuestion[], answers: AskAnswer[]): Record<string, unknown> {
  const content: Record<string, unknown> = {};
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
    if (custom) content[`${q.key}_custom`] = custom;
  });
  return content;
}

/** A one-line reading of an answer, for the transcript. */
export function askSummary(questions: AskQuestion[], content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const q of questions) {
    const v = content[q.key];
    const picked = Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
    const custom = content[`${q.key}_custom`];
    if (typeof custom === "string" && custom) picked.push(custom);
    if (picked.length) parts.push(picked.join(", "));
  }
  return parts.join(" · ");
}
