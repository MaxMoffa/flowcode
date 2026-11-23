// "The link to the computer is down", debounced so a blip never flashes a screen.
import { useEffect, useState } from "react";
import { useRemoteSelector } from "./remote";

/** Nothing loaded yet (tabs === null): the ghost loader shows first, so the link screen waits longer. */
const SHOW_AFTER = 1500;
const SHOW_AFTER_EMPTY = 3000;

/** True once the link has been connecting/offline for longer than a blip; false the moment it is online. */
export function useLinkDown(): boolean {
  const status = useRemoteSelector((s) => s.status);
  const firstConnect = useRemoteSelector((s) => s.firstConnect);
  const empty = useRemoteSelector((s) => s.tabs === null);
  const down = (status === "connecting" || status === "offline") && !firstConnect;
  const delay = empty ? SHOW_AFTER_EMPTY : SHOW_AFTER;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!down) {
      setArmed(false);
      return;
    }
    const id = setTimeout(() => setArmed(true), delay);
    return () => clearTimeout(id);
  }, [down, delay]);
  return down && armed;
}
