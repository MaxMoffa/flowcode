// Window-width driven layout: the narrow (phone-like) switch, whether the
// explorer docks or floats, and the panel rules that follow from them.
import { useEffect, useRef, useState } from "react";
import { usePanelPresence } from "../hooks/usePanelPresence";
import type { SidebarMode } from "../settings/modes";
import { NARROW_BREAKPOINT, SIDEBAR_AUTO_BREAKPOINT } from "./appPrefs";

type Setter<T> = (next: T | ((prev: T) => T)) => void;

interface NarrowLayoutInput {
  sidebarMode: SidebarMode;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Setter<boolean>;
  agentsSidebarOpen: boolean;
  setAgentsSidebarOpen: Setter<boolean>;
  browserOpen: boolean;
  setBrowserOpen: Setter<boolean>;
}

export function useNarrowLayout({
  sidebarMode,
  sidebarCollapsed,
  setSidebarCollapsed,
  agentsSidebarOpen,
  setAgentsSidebarOpen,
  browserOpen,
  setBrowserOpen,
}: NarrowLayoutInput) {
  // Booleans, not the raw width: React bails out of the re-render when a
  // resize frame doesn't cross a breakpoint.
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT);
  const [autoFloats, setAutoFloats] = useState(() => window.innerWidth < SIDEBAR_AUTO_BREAKPOINT);
  useEffect(() => {
    const onResize = () => {
      setIsNarrow(window.innerWidth < NARROW_BREAKPOINT);
      setAutoFloats(window.innerWidth < SIDEBAR_AUTO_BREAKPOINT);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Narrow windows have no room to dock a panel next to the terminal, so the
  // sidebar floats whatever its configured mode.
  const effectiveSidebarMode: "docked" | "floating" = isNarrow
    ? "floating"
    : sidebarMode === "auto"
      ? autoFloats
        ? "floating"
        : "docked"
      : sidebarMode;
  // Kept mounted a beat after closing so the docked panels can animate out.
  const sidebarDocked = effectiveSidebarMode === "docked" && !sidebarCollapsed;
  const sidebarPresence = usePanelPresence(sidebarDocked);
  const agentsPresence = usePanelPresence(agentsSidebarOpen);
  const browserPresence = usePanelPresence(browserOpen);

  // The panels are overlays when narrow, so only one may be open: whichever
  // was opened last wins (on entering narrow with several open, the first in
  // this order - sidebar, agents, browser - wins).
  const prevPanelsRef = useRef({ sidebar: !sidebarCollapsed, agents: agentsSidebarOpen, browser: browserOpen });
  useEffect(() => {
    const prev = prevPanelsRef.current;
    const panels = [
      { key: "sidebar", open: !sidebarCollapsed, close: () => setSidebarCollapsed(true) },
      { key: "agents", open: agentsSidebarOpen, close: () => setAgentsSidebarOpen(false) },
      { key: "browser", open: browserOpen, close: () => setBrowserOpen(false) },
    ] as const;
    prevPanelsRef.current = { sidebar: panels[0].open, agents: panels[1].open, browser: panels[2].open };
    if (!isNarrow) return;
    const open = panels.filter((p) => p.open);
    if (open.length < 2) return;
    // The one that just opened stays; with none new (entering narrow) the first wins.
    const fresh = open.filter((p) => !prev[p.key]);
    const keep = fresh.length > 0 ? fresh[fresh.length - 1] : open[0];
    for (const p of open) if (p !== keep) p.close();
  }, [isNarrow, sidebarCollapsed, agentsSidebarOpen, browserOpen, setSidebarCollapsed, setAgentsSidebarOpen, setBrowserOpen]);

  useEffect(() => {
    if (!isNarrow || !agentsSidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAgentsSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, agentsSidebarOpen, setAgentsSidebarOpen]);

  useEffect(() => {
    if (!isNarrow || !browserOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBrowserOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, browserOpen, setBrowserOpen]);

  useEffect(() => {
    if (effectiveSidebarMode !== "floating" || sidebarCollapsed) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarCollapsed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [effectiveSidebarMode, sidebarCollapsed]);

  return { isNarrow, effectiveSidebarMode, sidebarPresence, agentsPresence, browserPresence };
}
