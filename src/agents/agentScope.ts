export { inProject } from "./historyRows";

/** The previous array when the polled one has the same content, so an
 * unchanged poll doesn't re-render the list. */
export function keepIfSame<T>(prev: T[], next: T[]): T[] {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
