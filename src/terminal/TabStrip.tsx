import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { listShellOptions, type ShellOption } from "./shellOptions";
import type { AppTab } from "../tabs/types";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { useOpenContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import "./tabstrip.css";

interface TabStripProps {
  tabs: AppTab[];
  activeId: string;
  dirtyIds?: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Creates a new terminal tab - `shellId` (a `list_shell_options` id, from
   * the "+" button's own context menu) picks a specific shell instead of the
   * configured default. */
  onNew: (shellId?: string) => void;
  onRename: (id: string, label: string) => void;
  /** Opens a second, independent copy of a tab - same cwd for a terminal,
   * same file for an editor. Not offered for the (singleton) settings tab. */
  onDuplicate: (id: string) => void;
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

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5 10.5 12.5 7 15.5" />
      <line x1="12" y1="15.5" x2="16" y2="15.5" />
    </svg>
  );
}

/** Same terminal-box shape as PromptIcon, but a plain chevron with no
 * underscore bar - a deliberately small, brand-neutral difference from cmd's
 * own icon (this app draws no real shell logos) so PowerShell/pwsh rows
 * still read as visually distinct from the cmd row in the "+" button's
 * shell-picker menu. */
function ChevronBoxIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M8 9 13 12 8 15" />
    </svg>
  );
}

/** Generic "Linux" stand-in (an abstract penguin silhouette, not the Tux
 * artwork itself) for the WSL shell option. */
function PenguinIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <path d="M12 3.5c-2.6 0-4.3 2-4.3 4.6 0 1.4.4 2.3.4 3.4 0 2-1.4 3.3-1.4 5.7 0 2 2.3 3.3 5.3 3.3s5.3-1.3 5.3-3.3c0-2.4-1.4-3.7-1.4-5.7 0-1.1.4-2 .4-3.4 0-2.6-1.7-4.6-4.3-4.6z" />
      <circle cx="10.2" cy="9.3" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="9.3" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.5 17.5 9 20.5M13.5 17.5 15 20.5" />
    </svg>
  );
}

/** Icon for a `list_shell_options` row, used in the "+" button's own
 * shell-picker context menu (see TabStrip's onContextMenu handler below) -
 * `id` is the same id `pty_spawn`'s `shell` argument and `resolve_shell` in
 * pty.rs understand. */
function shellOptionIcon(id: string) {
  if (id === "wsl") return <PenguinIcon />;
  if (id === "cmd") return <PromptIcon />;
  if (id === "powershell" || id === "pwsh") return <ChevronBoxIcon />;
  if (id === "system") return <GearIcon />;
  // zsh/bash/sh (macOS/Linux builds) - same neutral prompt icon as cmd,
  // nothing platform-specific to tell them apart with.
  return <PromptIcon />;
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
  onCloseTab: (id: string) => void;
  /** Closes the overflow popup itself (Escape, click outside) - distinct
   * from `onCloseTab`, which closes one of the tabs listed inside it. */
  onDismiss: () => void;
}

function TabOverflowMenu({ tabs, activeId, anchorRect, onSelect, onCloseTab, onDismiss }: TabOverflowMenuProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

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
          <div
            key={tab.id}
            className={"tab-overflow-item" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => {
              onSelect(tab.id);
              onDismiss();
            }}
          >
            {tabIcon(tab)}
            <span className="tab-overflow-item-label">{tab.label}</span>
            <button
              type="button"
              className="tab-overflow-item-close"
              aria-label={`Close ${tab.label}`}
              onClick={(e) => {
                e.stopPropagation();
                // Closing the last hidden tab leaves nothing left to show in
                // this popup, so it's dismissed along with it rather than
                // left open and empty.
                if (filtered.length === 1) onDismiss();
                onCloseTab(tab.id);
              }}
            >
              <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function TabStrip({ tabs, activeId, dirtyIds, onSelect, onClose, onNew, onRename, onDuplicate }: TabStripProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [overflowAnchorRect, setOverflowAnchorRect] = useState<DOMRect | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [lastFolderSelection, setLastFolderSelection] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderTabRef = useRef<HTMLDivElement>(null);
  const openMenu = useOpenContextMenu();
  // Fetched once, purely to answer "is there more than one shell to offer" -
  // same list Settings uses for the default-shell picker (see
  // list_shell_options in pty.rs), already filtered there to what's actually
  // usable on this OS/machine (a WSL entry only exists here when it's really
  // installed).
  const [shellOptions, setShellOptions] = useState<ShellOption[]>([]);

  useEffect(() => {
    listShellOptions().then(setShellOptions);
  }, []);

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

  function tabMenuItems(tab: AppTab): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      // Same effect as double-clicking the label - just reachable without
      // knowing that gesture exists.
      { label: "Rinomina", onSelect: () => startEditing(tab) },
    ];
    if (tab.kind !== "settings") {
      items.push({ label: "Duplica", onSelect: () => onDuplicate(tab.id) });
    }
    items.push({ separator: true, label: "sep-close" });
    items.push({ label: "Chiudi", danger: true, onSelect: () => onClose(tab.id) });
    return items;
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
        return (
          <div
            key={tab.id}
            className={"term-tab" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => openMenu(e, tabMenuItems(tab))}
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
      <button
        type="button"
        className="term-tab-new"
        aria-label="New terminal tab"
        title="Nuovo terminale (click destro per scegliere la shell)"
        onClick={() => onNew()}
        onContextMenu={(e) => {
          // Only worth a picker when there's an actual choice - one option
          // (just "system") means this would open on a menu with nothing
          // useful to pick, so it falls straight through to a plain new tab.
          if (shellOptions.length <= 1) {
            onNew();
            return;
          }
          openMenu(
            e,
            shellOptions.map((opt) => ({ label: opt.label, icon: shellOptionIcon(opt.id), onSelect: () => onNew(opt.id) })),
          );
        }}
      >
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
          onCloseTab={onClose}
          onDismiss={() => setOverflowAnchorRect(null)}
        />
      )}
    </div>
  );
}
