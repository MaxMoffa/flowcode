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
// of measuring each one - see tabstrip.css for the matching values.
const TAB_SLOT = 162; // 160px tab + 2px gap
const NEW_BTN_SLOT = 28; // 26px button + 2px gap
const FOLDER_BTN_SLOT = 36; // 32px fixed-size button + 4px margin-left

function computeVisibleCount(containerWidth: number, total: number): number {
  if (total === 0 || containerWidth <= 0) return total;
  const withoutFolder = Math.floor((containerWidth - NEW_BTN_SLOT) / TAB_SLOT);
  if (withoutFolder >= total) return total;
  const withFolder = Math.floor((containerWidth - NEW_BTN_SLOT - FOLDER_BTN_SLOT) / TAB_SLOT);
  return Math.max(1, Math.min(withFolder, total - 1));
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" stroke="currentColor" fill="none">
      <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
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

  const menuWidth = 240;
  const style: CSSProperties = {
    top: anchorRect.bottom + 4,
    left: Math.max(8, Math.min(anchorRect.right - menuWidth, window.innerWidth - menuWidth - 8)),
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
            {tab.kind === "terminal" ? <span className="term-tab-dot" /> : <FileTypeIcon name={tab.label} />}
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
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderBtnRef = useRef<HTMLButtonElement>(null);

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

  const visibleCount = computeVisibleCount(containerWidth, tabs.length);
  const hiddenCount = tabs.length - visibleCount;

  // Always a stable *prefix* of the tab list - a plain derived value with no
  // memory of its own, so there's no stored window position to drift out of
  // sync. Tabs already in the bar never move: growing the window only
  // reveals more of the *tail* (the newest overflow), appended to the right
  // where the folder icon sits, instead of hidden tabs reappearing on the
  // opposite (left) side of tabs that were already visible. A freshly
  // created tab lands in the bar if there's room, or in the folder
  // otherwise - same as any other overflow tab, surfaced there via the
  // active-tab highlight rather than yanked into view. Selecting a tab from
  // the overflow menu does NOT change this list, by design - it stays
  // grouped in the folder, highlighted there, instead of jumping into the bar.
  const visibleTabs = tabs.slice(0, visibleCount);
  const hiddenTabs = tabs.slice(visibleCount);
  const activeIsHidden = hiddenTabs.some((t) => t.id === activeId);

  return (
    <div className="tab-strip" ref={containerRef} data-tauri-drag-region>
      {visibleTabs.map((tab) => {
        const canClose = tab.kind === "terminal" ? tabs.filter((t) => t.kind === "terminal").length > 1 : true;
        return (
          <div
            key={tab.id}
            className={"term-tab" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => onSelect(tab.id)}
            title={tab.kind === "terminal" ? tab.cwd : tab.path}
          >
            {tab.kind === "terminal" ? (
              <span className="term-tab-dot" />
            ) : (
              <FileTypeIcon name={tab.label} />
            )}
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
      <button type="button" className="term-tab-new" aria-label="New terminal tab" title="New terminal" onClick={() => onNew()}>
        <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {hiddenCount > 0 && (
        <button
          ref={folderBtnRef}
          type="button"
          className={"tab-overflow-btn" + (activeIsHidden ? " is-active" : "")}
          aria-label={`${hiddenCount} altre tab`}
          title={activeIsHidden ? "La tab attiva è qui dentro" : `${hiddenCount} altre tab`}
          onClick={() => {
            if (overflowAnchorRect) {
              setOverflowAnchorRect(null);
            } else {
              setOverflowAnchorRect(folderBtnRef.current?.getBoundingClientRect() ?? null);
            }
          }}
        >
          <FolderIcon />
          <span className="tab-overflow-count">{hiddenCount}</span>
        </button>
      )}
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
