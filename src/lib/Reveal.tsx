import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePresence } from "../hooks/usePresence";
import "./reveal.css";

/**
 * Opens and closes its content in place: the height runs through a grid row
 * (0fr -> 1fr, no measuring, no max-height guess) while the content fades.
 * Closing keeps the last content drawn (inert) until the animation is over,
 * so a card that the data already dropped still leaves smoothly.
 */
export function Reveal({
  show,
  children,
  className,
  appear = false,
  onExited,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
  /** Animate in when mounted already shown (an item added to a list). */
  appear?: boolean;
  /** The exit is over (nothing drawn any more). */
  onExited?: () => void;
}) {
  const { mounted, state, onAnimationEnd } = usePresence(show, { appear });
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;
  const wasMounted = useRef(mounted);
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;
  useEffect(() => {
    if (wasMounted.current && !mounted) exitedRef.current?.();
    wasMounted.current = mounted;
  }, [mounted]);
  if (!mounted) return null;
  return (
    <div className={"reveal" + (className ? ` ${className}` : "")} data-state={state} onAnimationEnd={onAnimationEnd} inert={state === "closing"}>
      <div className="reveal-inner">{show ? children : last.current}</div>
    </div>
  );
}

/** A list whose items open and close in place (see Reveal); removed items stay until their exit ends. */
export function RevealList<T>({
  items,
  getKey,
  render,
  className,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  render: (item: T) => ReactNode;
  className?: string;
}) {
  const [rows, setRows] = useState(() => items.map((item) => ({ key: getKey(item), item, live: true, appear: false })));
  const [seen, setSeen] = useState(items);
  if (seen !== items) {
    setSeen(items);
    const fresh = new Map(items.map((item) => [getKey(item), item]));
    const next = rows.map((row) => {
      const item = fresh.get(row.key);
      return item !== undefined ? { ...row, item, live: true } : { ...row, live: false };
    });
    const known = new Set(rows.map((row) => row.key));
    for (const item of items) {
      const key = getKey(item);
      if (!known.has(key)) next.push({ key, item, live: true, appear: true });
    }
    setRows(next);
  }
  return (
    <>
      {rows.map((row) => (
        <Reveal
          key={row.key}
          show={row.live}
          appear={row.appear}
          className={className}
          onExited={() => setRows((cur) => cur.filter((r) => r.key !== row.key || r.live))}
        >
          {render(row.item)}
        </Reveal>
      ))}
    </>
  );
}
