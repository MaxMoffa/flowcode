// Window-width driven layout of the side panels. The `open` flags the user
// controls stay the source of truth for "wanted open"; what is actually
// displayed is derived here. A panel that is wanted but has no room is PARKED
// (hidden, not closed) and returns on its own when space does. Narrow
// (phone-like) windows dock nothing: a panel is a transient overlay there.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelPresence } from "../hooks/usePanelPresence";
import type { SidebarMode } from "../settings/modes";
import { NARROW_BREAKPOINT } from "./appPrefs";
import { solvePanels, type LayoutResult, type PanelKey } from "./panelLayout";

type Setter<T> = (next: T | ((prev: T) => T)) => void;

const KEYS: PanelKey[] = ["sidebar", "browser", "agents"];
/** Most recent first; with nothing touched yet the browser outranks the sidebar, then the agents. */
const INITIAL_ORDER: PanelKey[] = ["browser", "sidebar", "agents"];
/** `.app-body` side padding (8px each) and the gap between cards. */
const BODY_PADDING = 16;
const GAP = 8;

interface PanelLayoutInput {
  sidebarMode: SidebarMode;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Setter<boolean>;
  agentsSidebarOpen: boolean;
  setAgentsSidebarOpen: Setter<boolean>;
  browserOpen: boolean;
  setBrowserOpen: Setter<boolean>;
  /** The `.app-body` element whose width the panels share with the center. */
  bodyRef: RefObject<HTMLElement | null>;
  /** The least width the chat/terminal should keep. */
  centerMin: number;
  /** Each panel's preferred (user-dragged) width and its minimum. */
  panels: Record<PanelKey, { width: number; min: number }>;
}

const EMPTY: LayoutResult = { shown: {}, parked: [], maxWidth: {} };

export function usePanelLayout({
  sidebarMode,
  sidebarCollapsed,
  setSidebarCollapsed,
  agentsSidebarOpen,
  setAgentsSidebarOpen,
  browserOpen,
  setBrowserOpen,
  bodyRef,
  centerMin,
  panels,
}: PanelLayoutInput) {
  // Booleans, not the raw width: React bails out of the re-render when a
  // resize frame doesn't cross the breakpoint.
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < NARROW_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Room for the docked panels plus the center, i.e. the body without its padding.
  const [available, setAvailable] = useState(() => window.innerWidth - BODY_PADDING);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setAvailable(Math.max(0, el.clientWidth - BODY_PADDING));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bodyRef]);

  const open: Record<PanelKey, boolean> = { sidebar: !sidebarCollapsed, agents: agentsSidebarOpen, browser: browserOpen };
  const setOpen = (key: PanelKey, value: boolean) => {
    if (key === "sidebar") setSidebarCollapsed(!value);
    else if (key === "agents") setAgentsSidebarOpen(value);
    else setBrowserOpen(value);
  };

  // Priority is recency: the panel the user last opened, toggled or clicked into wins the room.
  const [order, setOrder] = useState<PanelKey[]>(INITIAL_ORDER);
  const bump = useCallback((key: PanelKey) => setOrder((o) => (o[0] === key ? o : [key, ...o.filter((k) => k !== key)])), []);

  // A panel shown over the content without being docked: any panel when
  // narrow, the auto-mode sidebar when it is parked and the user asked for it.
  const [peek, setPeek] = useState<PanelKey | null>(null);

  const sidebarFloats = sidebarMode === "floating";
  const solved = isNarrow
    ? EMPTY
    : solvePanels(
        available,
        centerMin,
        GAP,
        order
          .filter((k) => open[k] && !(k === "sidebar" && sidebarFloats))
          .map((k) => ({ key: k, width: panels[k].width, min: panels[k].min })),
      );

  const overlay: PanelKey | null = isNarrow
    ? peek && open[peek]
      ? peek
      : null
    : peek === "sidebar" && sidebarMode === "auto" && open.sidebar && solved.parked.includes("sidebar")
      ? "sidebar"
      : null;
  /** The sidebar is on screen as the floating panel (not docked). */
  const sidebarOverlay = isNarrow ? overlay === "sidebar" : sidebarFloats ? open.sidebar : overlay === "sidebar";
  const parked: Record<PanelKey, boolean> = {
    sidebar: isNarrow ? open.sidebar && overlay !== "sidebar" : !sidebarFloats && solved.parked.includes("sidebar") && overlay !== "sidebar",
    agents: isNarrow ? open.agents && overlay !== "agents" : solved.parked.includes("agents"),
    browser: isNarrow ? open.browser && overlay !== "browser" : solved.parked.includes("browser"),
  };

  // A panel that just opened takes priority; narrow, it also shows as the
  // overlay - unless the opening is a restore (a tab switch bringing back that
  // tab's panels), which the user didn't ask for: those stay parked.
  const prevOpenRef = useRef(open);
  const restoringRef = useRef(false);
  const markRestore = useCallback(() => {
    restoringRef.current = true;
  }, []);
  useEffect(() => {
    const prev = prevOpenRef.current;
    prevOpenRef.current = open;
    const restoring = restoringRef.current;
    restoringRef.current = false;
    const opened = KEYS.filter((k) => open[k] && !prev[k]);
    for (const k of opened) bump(k);
    if (isNarrow && !restoring && opened.length > 0) setPeek(opened[opened.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed, agentsSidebarOpen, browserOpen]);
  // Entering or leaving narrow starts from no overlay; a closed panel has no overlay either.
  useEffect(() => setPeek(null), [isNarrow]);
  useEffect(() => {
    if (peek && !open[peek]) setPeek(null);
  }, [peek, sidebarCollapsed, agentsSidebarOpen, browserOpen]);

  /** One toggle for every entry point (button, shortcut, plugin action). */
  const togglePanel = (key: PanelKey) => {
    if (overlay === key) {
      setPeek(null);
    } else if (isNarrow) {
      // Closed ones open (the effect above then shows them); open ones just come forward.
      if (open[key]) setPeek(key);
      else setOpen(key, true);
    } else if (open[key] && parked[key]) {
      // Parked: bring it forward (something else gives way), except the auto sidebar, which peeks.
      if (key === "sidebar" && sidebarMode === "auto") setPeek("sidebar");
      else bump(key);
    } else {
      setOpen(key, !open[key]);
    }
  };

  /** Backdrop click on the floating sidebar. */
  const dismissSidebarOverlay = () => {
    if (!isNarrow && sidebarFloats) setSidebarCollapsed(true);
    else setPeek(null);
  };
  /** Backdrop click on a narrow agents/browser overlay. */
  const dismissOverlay = () => setPeek(null);

  /** Pointer down inside a panel makes it the top priority. */
  const panelPointerDown = (key: PanelKey) => () => bump(key);

  useEffect(() => {
    const floatingOpen = !isNarrow && sidebarFloats && !sidebarCollapsed;
    if (!overlay && !floatingOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (overlay) setPeek(null);
      else setSidebarCollapsed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, isNarrow, sidebarFloats, sidebarCollapsed, setSidebarCollapsed]);

  // Kept mounted a beat after hiding so the docked panels can animate out.
  const sidebarPresence = usePanelPresence(!isNarrow && solved.shown.sidebar !== undefined);
  const agentsPresence = usePanelPresence(isNarrow ? overlay === "agents" : solved.shown.agents !== undefined);
  const browserPresence = usePanelPresence(isNarrow ? overlay === "browser" : solved.shown.browser !== undefined);

  // While a panel animates out it has no solved width; keep its last one so its content doesn't reflow.
  const lastWidthRef = useRef<Partial<Record<PanelKey, number>>>({});
  for (const k of KEYS) {
    const w = solved.shown[k];
    if (w !== undefined) lastWidthRef.current[k] = w;
  }
  const widthOf = (key: PanelKey) => solved.shown[key] ?? lastWidthRef.current[key] ?? panels[key].width;

  return {
    isNarrow,
    sidebarOverlay,
    overlay,
    parked,
    shown: solved.shown,
    maxWidth: solved.maxWidth,
    widthOf,
    togglePanel,
    markRestore,
    panelPointerDown,
    dismissSidebarOverlay,
    dismissOverlay,
    sidebarPresence,
    agentsPresence,
    browserPresence,
  };
}
