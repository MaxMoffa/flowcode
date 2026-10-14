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
}

export function useNarrowLayout({
  sidebarMode,
  sidebarCollapsed,
  setSidebarCollapsed,
  agentsSidebarOpen,
  setAgentsSidebarOpen,
}: NarrowLayoutInput) {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isNarrow = windowWidth < NARROW_BREAKPOINT;
  // Narrow windows have no room to dock a panel next to the terminal, so the
  // sidebar floats whatever its configured mode.
  const effectiveSidebarMode: "docked" | "floating" = isNarrow
    ? "floating"
    : sidebarMode === "auto"
      ? windowWidth < SIDEBAR_AUTO_BREAKPOINT
        ? "floating"
        : "docked"
      : sidebarMode;
  // Kept mounted a beat after closing so the docked panels can animate out.
  const sidebarDocked = effectiveSidebarMode === "docked" && !sidebarCollapsed;
  const sidebarPresence = usePanelPresence(sidebarDocked);
  const agentsPresence = usePanelPresence(agentsSidebarOpen);

  // Both panels are overlays when narrow, so only one may be open: whichever
  // was opened last wins (on entering narrow with both open, the sidebar wins).
  const prevPanelsRef = useRef({ sidebarOpen: !sidebarCollapsed, agentsOpen: agentsSidebarOpen });
  useEffect(() => {
    const prev = prevPanelsRef.current;
    const sidebarOpen = !sidebarCollapsed;
    prevPanelsRef.current = { sidebarOpen, agentsOpen: agentsSidebarOpen };
    if (!isNarrow || !sidebarOpen || !agentsSidebarOpen) return;
    if (!prev.agentsOpen) setSidebarCollapsed(true);
    else setAgentsSidebarOpen(false);
  }, [isNarrow, sidebarCollapsed, agentsSidebarOpen, setSidebarCollapsed, setAgentsSidebarOpen]);

  useEffect(() => {
    if (!isNarrow || !agentsSidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAgentsSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, agentsSidebarOpen, setAgentsSidebarOpen]);

  useEffect(() => {
    if (effectiveSidebarMode !== "floating" || sidebarCollapsed) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarCollapsed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [effectiveSidebarMode, sidebarCollapsed]);

  return { isNarrow, effectiveSidebarMode, sidebarPresence, agentsPresence };
}
