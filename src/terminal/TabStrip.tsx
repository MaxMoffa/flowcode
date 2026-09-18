import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AppTab } from "../tabs/types";
import { FileTypeIcon } from "../sidebar/fileIcons";
import "./tabstrip.css";

interface TabStripProps {
  tabs: AppTab[];
  activeId: string;
  dirtyIds?: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, label: string) => void;
}

// Tabs have a fixed CSS width, so how many fit is plain arithmetic instead
// of measuring each one - see tabstrip.css for the matching values. The
// folder tab takes up exactly one regular tab slot (same size), so there's
// no separate reservation for it.
const TAB_SLOT = 162; // 160px tab + 2px gap
const NEW_BTN_SLOT = 28; // 26px button + 2px gap

function computeVisibleSlots(containerWidth: number, total: number): number {
  if (total === 0 || containerWidth <= 0) return total;
  const maxSlots = Math.floor((containerWidth - NEW_BTN_SLOT) / TAB_SLOT);
  return Math.max(1, Math.min(maxSlots, total));
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" stroke="currentColor" fill="none">
      <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" />
    </svg>
  );
}

function tabIcon(tab: AppTab) {
  if (tab.kind === "terminal") return <span className="term-tab-dot" />;
  if (tab.kind === "settings") return <GearIcon />;
  return <FileTypeIcon name={tab.label} />;
}

function tabTitle(tab: AppTab): string {
  if (tab.kind === "terminal") return tab.cwd;
  if (tab.kind === "editor") return tab.path;
  return tab.label;
}

interface TabOverflowMenuProps {
  tabs: AppTab[];
  activeId: string;
  anchorRect: DOMRect;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function TabOverflowMenu({ tabs, activeId, anchorRect, onSelect, onClose }: TabOverflowMenuProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const filtered = tabs.filter((t) => t.label.toLowerCase().includes(query.trim().toLowerCase()));

  // Same width as the tab it unfolds from, anchored right under it - the
  // opening animation (see tabstrip.css) is what sells the illusion that
  // the tab itself is the thing expanding open.
  const style: CSSProperties = {
    top: anchorRect.bottom + 2,
    left: anchorRect.left,
    width: anchorRect.width,
  };

  return createPortal(
    <div className="tab-overflow-menu" style={style} ref={menuRef}>
      <input
        ref={inputRef}
        className="tab-overflow-search"
        placeholder="Cerca tab…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tab-overflow-list">
        {filtered.length === 0 && <div className="tab-overflow-empty">Nessun risultato</div>}
        {filtered.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={"tab-overflow-item" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => {
              onSelect(tab.id);
              onClose();
            }}
          >
            {tabIcon(tab)}
            <span className="tab-overflow-item-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function TabStrip({ tabs, activeId, dirtyIds, onSelect, onClose, onNew, onRename }: TabStripProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [overflowAnchorRect, setOverflowAnchorRect] = useState<DOMRect | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [lastFolderSelection, setLastFolderSelection] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function startEditing(tab: AppTab) {
    setEditingId(tab.id);
    setDraft(tab.label);
  }

  function commitEditing() {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  }

  const totalSlots = computeVisibleSlots(containerWidth, tabs.length);
  const hasOverflow = totalSlots < tabs.length;
  // One of the fitted slots becomes the folder tab itself when there's
  // overflow, so it never shows a "folder of one" - whatever doesn't fit
  // regularly plus that reserved slot is always at least two tabs.
  const regularCount = hasOverflow ? Math.max(0, totalSlots - 1) : totalSlots;

  // Always a stable *prefix* of the tab list - a plain derived value with no
  // memory of its own, so there's no stored window position to drift out of
  // sync. Tabs already in the bar never move: growing the window only turns
  // more of the *tail* (the newest overflow) back into regular tabs, right
  // where the folder tab sits, instead of hidden tabs reappearing on the
  // opposite side of tabs that were already visible.
  const visibleTabs = tabs.slice(0, regularCount);
  const hiddenTabs = tabs.slice(regularCount);
  const activeInFolder = hiddenTabs.find((t) => t.id === activeId);
  // Remember the last hidden tab that was actually selected (set
  // synchronously during render, React's documented way to react to a prop
  // change without an extra render's lag) so switching to a regular tab and
  // back doesn't reset the folder's preview to some arbitrary tab - it
  // keeps showing whichever one you were last looking at in there.
  if (activeInFolder && activeInFolder.id !== lastFolderSelection) {
    setLastFolderSelection(activeInFolder.id);
  }
  const rememberedTab = hiddenTabs.find((t) => t.id === lastFolderSelection);
  // What the folder tab itself displays: the active hidden tab if there is
  // one, otherwise the last one that was, otherwise the most recent tab in
  // the group - reasonable stand-ins for a preview, in that order.
  const folderPreview = activeInFolder ?? rememberedTab ?? hiddenTabs[hiddenTabs.length - 1];

  function handleFolderTabClick() {
    if (!folderPreview) return;
    if (overflowAnchorRect) {
      setOverflowAnchorRect(null);
    } else if (activeInFolder) {
      // Already the selected tab - a second click is what opens the list.
      setOverflowAnchorRect(folderTabRef.current?.getBoundingClientRect() ?? null);
    } else {
      onSelect(folderPreview.id);
    }
  }

  return (
    <div className="tab-strip" ref={containerRef} data-tauri-drag-region>
      {visibleTabs.map((tab) => {
        const canClose = tab.kind === "terminal" ? tabs.filter((t) => t.kind === "terminal").length > 1 : true;
        return (
          <div
            key={tab.id}
            className={"term-tab" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => onSelect(tab.id)}
            title={tabTitle(tab)}
          >
            {tabIcon(tab)}
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                className="term-tab-rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEditing();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span
                className="term-tab-label"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEditing(tab);
                }}
              >
                {tab.label}
              </span>
            )}
            {tab.kind === "editor" && dirtyIds?.has(tab.id) && (
              <span className="term-tab-dirty-dot" title="Modifiche non salvate" />
            )}
            {canClose && (
              <button
                type="button"
                className="term-tab-close"
                aria-label={`Close ${tab.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
      {folderPreview && (
        <div
          ref={folderTabRef}
          className={"term-tab term-tab-folder" + (activeInFolder ? " is-active" : "")}
          onClick={handleFolderTabClick}
          title={activeInFolder ? "Clicca di nuovo per vedere le altre" : `${hiddenTabs.length} tab raggruppate`}
        >
          <span className="term-tab-folder-icon">
            <FolderIcon />
            <span className="tab-overflow-count">{hiddenTabs.length}</span>
          </span>
          <span className="term-tab-label">{folderPreview.label}</span>
        </div>
      )}
      <button type="button" className="term-tab-new" aria-label="New terminal tab" title="New terminal" onClick={() => onNew()}>
        <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {overflowAnchorRect && (
        <TabOverflowMenu
          tabs={hiddenTabs}
          activeId={activeId}
          anchorRect={overflowAnchorRect}
          onSelect={onSelect}
          onClose={() => setOverflowAnchorRect(null)}
        />
      )}
    </div>
  );
}
