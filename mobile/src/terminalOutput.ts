/** The last `count` lines of `text` that aren't blank. */
export function tailLines(text: string, count: number): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}
