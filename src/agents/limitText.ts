// Pure text parsing of the CLIs' usage-limit notices (no imports, so the phone app can use it too).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = `(${MONTHS.join("|")})[a-z]*\\.?`;
/** "Sep 19" (Claude Code) / "20 Sep" / "Sep 20th, 2026" (Codex). */
const ORDINAL = "(?:st|nd|rd|th)?";
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}\\b`);
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+${MONTH}`);

/** When a reset worded by the CLI happens - Claude Code: "3pm (Europe/Rome)",
 * "Sep 19, 12am (Europe/Rome)"; Codex: "07:32", "07:32 on 20 Sep". Read as
 * local time; a bare time is its next occurrence. `null` when unreadable. */
export function parseResetTime(text: string, now = new Date()): number | null {
  // The time zone in parentheses is the user's own.
  let s = text.replace(/\([^)]*\)/g, " ").toLowerCase();
  let hours = 0;
  let minutes = 0;
  const time = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2] ?? 0);
    if (time[3]) hours = (hours % 12) + (time[3] === "pm" ? 12 : 0);
    if (hours > 23 || minutes > 59) return null;
    s = s.replace(time[0], " ");
  }
  const date = s.match(MONTH_DAY_RE) ?? s.match(DAY_MONTH_RE);
  if (date) {
    const [monthName, day] = /\d/.test(date[1]) ? [date[2], date[1]] : [date[1], date[2]];
    const at = new Date(now.getFullYear(), MONTHS.indexOf(monthName), Number(day), hours, minutes);
    // "Jan 2" read in late December is next year's.
    if (at.getTime() < now.getTime() - 180 * 86_400_000) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  if (!time) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** A dateless reset ("resets 7:20pm") is read as that time's next occurrence,
 * so an old notice still on screen after its reset would point at tomorrow.
 * The 5-hour window can't reset further away than this: past it, the notice
 * is stale. */
const MAX_DATELESS_MS = 5 * 3_600_000 + 10 * 60_000;
const MONTH_RE = new RegExp(`\\b(?:${MONTHS.join("|")})[a-z]*\\b`, "i");

/** `parseResetTime`, but `null` for a dateless reset further away than the
 * 5-hour window allows (a stale notice, see MAX_DATELESS_MS). */
export function parseResetTimeGuarded(text: string, now = new Date()): number | null {
  const at = parseResetTime(text, now);
  if (at !== null && !MONTH_RE.test(text) && at - now.getTime() > MAX_DATELESS_MS) return null;
  return at;
}

// Claude Code: "You've hit your limit · resets 3pm"; Codex: "You've hit your
// usage limit. ... or try again at Oct 20th, 2026 3:45 PM." The terminal wraps
// these, so spaces and the reset's own text may span lines.
const LIMIT_RE = /hit\s+your\s+(?:session\s+|weekly\s+|usage\s+)?limit/gi;
const RESETS_RE = /resets\s+(.+?)(?:\n|$)/i;
const TRY_AGAIN_RE = /try\s+again\s+at\s+([^.]{1,48})/i;
/** Reads a usage-limit notice off the screen text (its last occurrence - older
 * ones may still be scrolled in). `at` is the reset time, null when the notice
 * doesn't say, says it in a way parseResetTime can't read, or is a stale
 * dateless one (see parseResetTimeGuarded). */
export function detectLimit(text: string, now = new Date()): { at: number | null } | null {
  let last = -1;
  for (const m of text.matchAll(LIMIT_RE)) last = m.index ?? last;
  if (last < 0) return null;
  const rest = text.slice(last);
  const when = rest.match(RESETS_RE)?.[1] ?? rest.match(TRY_AGAIN_RE)?.[1]?.replace(/\s+/g, " ");
  return { at: when ? parseResetTimeGuarded(when, now) : null };
}
