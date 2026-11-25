import { useEffect, useState } from "react";

/** Rows of a folder listing drawn at first: a node_modules would otherwise mount thousands of buttons. */
const ROW_CAP = 300;

/** The first `ROW_CAP` rows of `items` (more on request); the cap starts over when `resetKey` (the folder) changes. */
export function useRowCap<A extends unknown[] | null | undefined>(items: A, resetKey: string) {
  const [limit, setLimit] = useState(ROW_CAP);
  useEffect(() => setLimit(ROW_CAP), [resetKey]);
  const total = items?.length ?? 0;
  return {
    rows: (items && total > limit ? items.slice(0, limit) : items) as A,
    hidden: Math.max(0, total - limit),
    showMore: () => setLimit((n) => n + ROW_CAP),
  };
}
