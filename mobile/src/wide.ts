import { useEffect, useState } from "react";

/** Tracks a CSS media query; false where matchMedia doesn't exist. */
function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Tablets and desktop-mode phones: the desktop-like layout. */
export const useWide = () => useMediaQuery("(min-width: 760px)");
/** Wide enough to keep the agents panel docked beside the terminal. */
export const useDocked = () => useMediaQuery("(min-width: 1100px)");
