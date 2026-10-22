/** How well `query` matches `text`, higher is better; null when it doesn't.
 * Every character of the query has to appear in the text, in order (case
 * ignored); runs of consecutive characters and matches at the start of a word
 * count for more, so "fc" finds "flowcode" before "front-cache-old". A blank
 * query matches everything. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s\\/_.:-]/.test(haystack[at - 1]);
    score += 1 + (at === previous + 1 ? 3 : 0) + (wordStart ? 2 : 0);
    previous = at;
    from = at + 1;
  }
  // A tighter, earlier match beats a scattered one of the same letters.
  return score - (previous - q.length) * 0.05;
}

/** `items` that match `query` on any of the texts `textsOf` gives, best first
 * (ties keep their order); all of them, in order, for a blank query. */
export function fuzzyFilter<T>(items: readonly T[], query: string, textsOf: (item: T) => string[]): T[] {
  if (query.trim() === "") return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let best: number | null = null;
    for (const text of textsOf(item)) {
      const score = fuzzyScore(query, text);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) scored.push({ item, score: best, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}
