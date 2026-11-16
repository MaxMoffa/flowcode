// Pure dictation text helpers, no imports: the phone uses them without pulling in the desktop hook.

/** `text` appended to `draft`, a space between them unless one is already there. */
export function appendDictation(draft: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return draft;
  if (!draft || /\s$/.test(draft)) return draft + spoken;
  return `${draft} ${spoken}`;
}
