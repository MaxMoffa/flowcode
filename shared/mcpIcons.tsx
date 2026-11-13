import { createContext, useContext, useEffect, useState } from "react";

/** Loads an MCP server's icon (a data: URI), null when there is none. Absent: monograms only. */
export type McpIconLoader = (serverKey: string) => Promise<string | null>;

export const McpIconSource = createContext<McpIconLoader | null>(null);

/** The icon of `serverKey` once loaded; null while loading, without one, or with no source. */
export function useMcpIcon(serverKey: string | undefined): string | null {
  const load = useContext(McpIconSource);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    setIcon(null);
    if (!load || !serverKey) return;
    let live = true;
    load(serverKey).then((v) => { if (live) setIcon(typeof v === "string" && v.startsWith("data:image/") ? v : null); }, () => {});
    return () => { live = false; };
  }, [load, serverKey]);
  return icon;
}
