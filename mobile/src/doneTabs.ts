const working = (s?: string) => s === "busy" || s === "waiting";

/** The tabs whose agent finished (busy/waiting -> anything else) while another tab was shown, like the desktop's "done" outline.
 * A tab leaves the set when it is shown or gone. `prevStatus` is the previous call's statuses; the caller refreshes it. */
export function nextDone(prevStatus: Map<string, string | undefined>, entries: { key: string; status?: string }[], shownKey: string | null, done: Set<string>): Set<string> {
  const live = new Set(entries.map((e) => e.key));
  const next = new Set([...done].filter((k) => live.has(k) && k !== shownKey));
  for (const e of entries) {
    if (e.key !== shownKey && working(prevStatus.get(e.key)) && !working(e.status)) next.add(e.key);
  }
  return next;
}
