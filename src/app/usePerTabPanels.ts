import { useEffect, useRef } from "react";
import { activatePage, setBrowserOpen, switchBrowserTab, takePendingPage } from "../browser/browserStore";

interface PanelsState {
  sidebarCollapsed: boolean;
  browserOpen: boolean;
}

/** Each tab keeps which side panels were open in it (not their widths): leaving a tab saves them, coming back restores them.
 * A tab not seen before inherits the file panel as it is but starts without the Browser, which belongs to the tab that opened it.
 * `restoreRef` is for usePanelLayout's markRestore, set once that hook has run; `forget` drops a closed tab's entry. */
export function usePerTabPanels(
  activeTabId: string,
  now: PanelsState,
  setSidebarCollapsed: (open: boolean) => void,
) {
  const panelsByTabRef = useRef(new Map<string, PanelsState>());
  const panelsNowRef = useRef(now);
  panelsNowRef.current = now;
  const panelsTabRef = useRef(activeTabId);
  const panelRestoreRef = useRef<() => void>(() => {});
  useEffect(() => {
    const previous = panelsTabRef.current;
    if (previous === activeTabId) return;
    panelsTabRef.current = activeTabId;
    const map = panelsByTabRef.current;
    map.set(previous, panelsNowRef.current);
    const next = map.get(activeTabId) ?? { ...panelsNowRef.current, browserOpen: false };
    // Each tab keeps its own page in front of the Browser.
    switchBrowserTab(previous, activeTabId);
    // A page an agent or dev server of this tab opened while the user was elsewhere shows now.
    const pending = takePendingPage(activeTabId);
    if (pending) activatePage(pending);
    const browser = next.browserOpen || pending !== null;
    const now = panelsNowRef.current;
    // Restored panels are not the user asking for them: in a narrow window they stay parked instead of popping over the content.
    if ((now.sidebarCollapsed && !next.sidebarCollapsed) || (!now.browserOpen && browser)) {
      panelRestoreRef.current();
    }
    setSidebarCollapsed(next.sidebarCollapsed);
    setBrowserOpen(browser);
  }, [activeTabId, setSidebarCollapsed]);
  return { restoreRef: panelRestoreRef, forget: (id: string) => void panelsByTabRef.current.delete(id) };
}
