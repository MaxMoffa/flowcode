import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useOpenContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { addFavorite, isFavorite, removeFavorite } from "../favorites/favoritesStore";
import { FileTypeIcon } from "./fileIcons";
import { FileInfoDialog } from "./FileInfoDialog";

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

function iconSvg(children: ReactElement) {
  return (
    // Explicit size, not just viewBox: an inline <svg> with no width/height
    // of its own falls back to the browser's default replaced-element size
    // (300x150) wherever the container doesn't happen to set one via CSS -
    // which is exactly what made the search icon balloon relative to its
    // neighbors (kebab has its own width/height set directly, so it was
    // never affected). This is a default, not an override - any container
    // with its own `svg { width; height }` rule still wins over this.
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      stroke="currentColor"
    >
      {children}
    </svg>
  );
}

const Icons = {
  open: iconSvg(<><rect x="4" y="6" width="16" height="13" rx="1.6" /><path d="M4 9h16" /></>),
  reveal: iconSvg(<><path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" /></>),
  openContaining: iconSvg(
    <>
      <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
      <path d="M9.5 15.5 12.5 12.5 9.5 9.5" />
    </>,
  ),
  rename: iconSvg(<><path d="M16.5 3.5 20.5 7.5 8 20 3.5 20.5 4 16z" /></>),
  duplicate: iconSvg(<><rect x="8.5" y="8.5" width="11" height="11" rx="1.6" /><path d="M15.5 8.5V5.6A1.6 1.6 0 0 0 13.9 4H5.6A1.6 1.6 0 0 0 4 5.6v8.3A1.6 1.6 0 0 0 5.6 15.5H8.5" /></>),
  copy: iconSvg(<><rect x="7" y="3.5" width="9" height="4" rx="1" /><path d="M15.5 5.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V7A1.5 1.5 0 0 1 6 5.5h2.5" /><line x1="8.5" y1="12" x2="15.5" y2="12" /><line x1="8.5" y1="16" x2="13.5" y2="16" /></>),
  newFile: iconSvg(<><path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" /><line x1="9" y1="14" x2="15" y2="14" /><line x1="12" y1="11" x2="12" y2="17" /></>),
  newFolder: iconSvg(<><path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" /><line x1="9.5" y1="10.5" x2="9.5" y2="15.5" /><line x1="7" y1="13" x2="12" y2="13" /></>),
  delete: iconSvg(<><path d="M5 7.5h14" /><path d="M9.5 7.5V5.6c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.9" /><path d="M7 7.5 7.7 19a1.3 1.3 0 0 0 1.3 1.3h6a1.3 1.3 0 0 0 1.3-1.3l.7-11.5" /></>),
  info: iconSvg(<><circle cx="12" cy="12" r="8.7" /><line x1="12" y1="11" x2="12" y2="16.5" /><circle cx="12" cy="8" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth="1.8" /></>),
  back: iconSvg(<polyline points="14.5 5 8 12 14.5 19" />),
  terminal: iconSvg(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><polyline points="7 9.5 10.5 12.5 7 15.5" /><line x1="12.5" y1="15.5" x2="16.5" y2="15.5" /></>),
  eye: iconSvg(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>),
  refresh: iconSvg(<><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" /><path d="M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" /><path d="M4 20v-4.5h4.5" /></>),
  search: iconSvg(<><circle cx="10.5" cy="10.5" r="6.5" /><line x1="15.3" y1="15.3" x2="20.5" y2="20.5" /></>),
  link: iconSvg(<><path d="M9.5 14.5 14.5 9.5" /><path d="M11 7.5 13 5.5a3 3 0 0 1 4.24 4.24l-2 2" /><path d="M13 16.5 11 18.5a3 3 0 0 1-4.24-4.24l2-2" /></>),
  star: iconSvg(<path d="M12 3.8l2.35 4.9 5.35.68-3.9 3.75.98 5.37L12 15.9l-4.78 2.6.98-5.37-3.9-3.75 5.35-.68z" />),
  kebab: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none">
      <circle cx="12" cy="5.5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="18.5" r="1.9" />
    </svg>
  ),
  smallCopy: (
    <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12" fill="none" stroke="currentColor">
      <rect x="7" y="3.5" width="9" height="4" rx="1" />
      <path d="M15.5 5.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V7A1.5 1.5 0 0 1 6 5.5h2.5" />
    </svg>
  ),
  smallCheck: (
    <svg viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12" fill="none" stroke="currentColor">
      <polyline points="5 12.5 10 17.5 19 7" />
    </svg>
  ),
};

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
    } catch {
      /* clipboard unavailable */
    }
    document.body.removeChild(el);
  }
}

function FolderGlyph() {
  return (
    <span className="file-tree-icon ft-folder">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none">
        <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
      </svg>
    </span>
  );
}

function EntryIcon({ entry }: { entry: FsEntry }) {
  return entry.is_dir ? <FolderGlyph /> : <FileTypeIcon name={entry.name} />;
}

/** Whether `path` is a top-level root the "up" button has nowhere above to
 * go from - a plain POSIX "/", a bare Windows drive ("C:" / "C:\\"), or a
 * WSL UNC share root ("\\\\wsl.localhost\\Ubuntu"). */
function isRootPath(path: string): boolean {
  if (!path || path === "/") return true;
  if (/^[A-Za-z]:\\?$/.test(path)) return true;
  if (path.startsWith("\\\\")) {
    return path.slice(2).split("\\").filter(Boolean).length <= 2;
  }
  return false;
}

/** The containing folder of `path`, one level up - separator-aware, since
 * `cwd` can be POSIX (macOS/Linux, or a real WSL bash session's own path),
 * a Windows drive path ("C:\\Users\\me"), or a WSL UNC path this app made up
 * for Explorer's sake ("\\\\wsl.localhost\\Ubuntu\\home\\me" - see
 * terminal/wslPath.ts). Splitting only on "/" here made every backslash path
 * fail to find any separator at all and fall straight through to "/" - the
 * "up" button always landing on root regardless of where it was clicked. */
function parentPath(path: string): string {
  if (isRootPath(path)) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  let trimmed = path;
  while (trimmed.length > 1 && trimmed.endsWith(sep)) trimmed = trimmed.slice(0, -1);

  if (sep === "/") {
    const idx = trimmed.lastIndexOf("/");
    return idx <= 0 ? "/" : trimmed.slice(0, idx);
  }

  if (trimmed.startsWith("\\\\")) {
    const parts = trimmed.slice(2).split("\\");
    return "\\\\" + parts.slice(0, -1).join("\\");
  }

  const driveRoot = trimmed.match(/^[A-Za-z]:\\/)?.[0];
  const idx = trimmed.lastIndexOf("\\");
  if (driveRoot && idx < driveRoot.length) return driveRoot;
  return trimmed.slice(0, idx);
}

/** Shows just the last two path segments so deep cwds don't push the menu
 * button off the sidebar - the full path is still available as a tooltip. */
function truncatePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 2) return path || "/";
  return "…/" + parts.slice(-2).join("/");
}

/** Exported so Settings → Informazioni's "Ripristina terminale" can clear it
 * as part of a full reset, without duplicating the key string. */
export const SHOW_HIDDEN_KEY = "flowcode.showHiddenFiles";

interface InlineEditRowProps {
  icon: React.ReactNode;
  initialValue: string;
  allowUnchanged?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function InlineEditRow({ icon, initialValue, allowUnchanged, onCommit, onCancel }: InlineEditRowProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    const trimmed = value.trim();
    if (!trimmed || (!allowUnchanged && trimmed === initialValue)) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }

  return (
    <div className="file-tree-row is-editing">
      <span className="file-tree-chevron-spacer" />
      {icon}
      <input
        ref={ref}
        className="file-tree-rename-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}

type ExplorerLinkMode = "auto" | "disconnesso";

interface FileTreeProps {
  cwd: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  linkMode: ExplorerLinkMode;
  onSetLinkMode: (mode: ExplorerLinkMode) => void;
  terminalBusy: boolean;
}

export function FileTree({
  cwd,
  onNavigate,
  onOpenFile,
  onOpenTerminal,
  linkMode,
  onSetLinkMode,
  terminalBusy,
}: FileTreeProps) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [infoEntry, setInfoEntry] = useState<FsEntry | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [headerRenameDraft, setHeaderRenameDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FsEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const openMenu = useOpenContextMenu();
  const confirm = useConfirmDialog();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerRenameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  function toggleSearch() {
    setSearchOpen((open) => {
      if (open) {
        setSearchQuery("");
        setSearchResults(null);
      }
      return !open;
    });
  }

  // Recursive (subfolders included) search, debounced so a fast typist
  // doesn't fire a filesystem walk on every keystroke. `read_dir`'s own
  // flat `entries` only ever cover the current folder, so a real query
  // needs the dedicated backend walk instead of a client-side filter.
  useEffect(() => {
    const query = searchQuery.trim();
    if (!searchOpen || !query || !cwd) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<FsEntry[]>("search_dir", { path: cwd, query, showHidden })
        .then((result) => {
          if (!cancelled) setSearchResults(result);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchOpen, searchQuery, cwd, showHidden]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  function handleCopyPath(path: string) {
    copyToClipboard(path);
    setCopiedPath(path);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedPath(null), 1200);
    setToast("Percorso copiato");
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  }

  const reload = useCallback(() => {
    if (!cwd) return;
    invoke<FsEntry[]>("read_dir", { path: cwd, showHidden })
      .then((result) => {
        setEntries(result);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [cwd, showHidden]);

  function toggleShowHidden() {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_HIDDEN_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  useEffect(() => {
    setCreating(null);
    setRenamingPath(null);
    reload();
  }, [reload]);

  function goUp() {
    if (cwd) onNavigate(parentPath(cwd));
  }

  function startEditPath() {
    if (!cwd) return;
    setHeaderRenameDraft(cwd);
    setRenamingPath(cwd);
  }

  useEffect(() => {
    if (renamingPath === cwd && cwd) {
      headerRenameInputRef.current?.focus();
      headerRenameInputRef.current?.select();
    }
  }, [renamingPath, cwd]);

  function commitPathEdit() {
    const trimmed = headerRenameDraft.trim().replace(/\/+$/, "") || "/";
    setRenamingPath(null);
    if (trimmed === cwd) return;
    onNavigate(trimmed);
  }

  function handleRowClick(entry: FsEntry) {
    if (entry.is_dir) {
      onNavigate(entry.path);
    } else {
      setSelected(entry.path);
    }
  }

  async function handleDelete(entry: FsEntry) {
    const kind = entry.is_dir ? "cartella" : "file";
    const ok = await confirm({
      title: "Elimina",
      message: `Eliminare la ${kind} "${entry.name}"? L'operazione non può essere annullata.`,
      confirmLabel: "Elimina",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("delete_entry", { path: entry.path, isDir: entry.is_dir });
      reload();
    } catch (e) {
      window.alert(`Impossibile eliminare: ${e}`);
    }
  }

  async function handleDuplicate(entry: FsEntry) {
    try {
      await invoke("duplicate_entry", { path: entry.path });
      reload();
    } catch (e) {
      window.alert(`Impossibile duplicare: ${e}`);
    }
  }

  async function commitRename(entry: FsEntry, newName: string) {
    try {
      await invoke("rename_entry", { path: entry.path, newName });
    } catch (e) {
      window.alert(`Impossibile rinominare: ${e}`);
    } finally {
      setRenamingPath(null);
      reload();
    }
  }

  async function commitCreate(kind: "file" | "dir", name: string) {
    try {
      await invoke(kind === "file" ? "create_file_entry" : "create_dir_entry", { dir: cwd, name });
    } catch (e) {
      window.alert(`Impossibile creare: ${e}`);
    } finally {
      setCreating(null);
      reload();
    }
  }

  function entryMenuItems(entry: FsEntry): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (!entry.is_dir) {
      items.push({ label: "Apri", icon: Icons.open, onSelect: () => onOpenFile(entry.path) });
    } else {
      items.push({
        label: "Apri in un altro terminale",
        icon: Icons.terminal,
        onSelect: () => onOpenTerminal(entry.path),
      });
    }
    // Only meaningful for a search result - while just browsing, an entry's
    // containing folder already *is* the current cwd, so this would be a
    // no-op offered on every single row for no reason.
    if (isSearching) {
      items.push({
        label: "Apri cartella contenente",
        icon: Icons.openContaining,
        onSelect: () => {
          onNavigate(parentPath(entry.path));
          setSelected(entry.path);
        },
      });
    }
    items.push({
      label: "Rivela nel file manager",
      icon: Icons.reveal,
      onSelect: () => revealItemInDir(entry.path).catch(() => {}),
    });
    if (entry.is_dir) {
      const fav = isFavorite(entry.path);
      items.push({
        label: fav ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti",
        icon: Icons.star,
        onSelect: () => (fav ? removeFavorite(entry.path) : addFavorite(entry.path)),
      });
    }
    items.push({ separator: true, label: "sep-1" });
    items.push({ label: "Rinomina", icon: Icons.rename, onSelect: () => setRenamingPath(entry.path) });
    items.push({ label: "Duplica", icon: Icons.duplicate, onSelect: () => handleDuplicate(entry) });
    items.push({ label: "Copia percorso", icon: Icons.copy, onSelect: () => handleCopyPath(entry.path) });
    items.push({ separator: true, label: "sep-2" });
    items.push({ label: "Informazioni", icon: Icons.info, onSelect: () => setInfoEntry(entry) });
    items.push({ separator: true, label: "sep-3" });
    items.push({ label: "Elimina", icon: Icons.delete, danger: true, onSelect: () => handleDelete(entry) });
    return items;
  }

  /** Whether clicking a folder in the tree actually `cd`s the terminal - see
   * `ExplorerLinkMode`. Exposed as a two-way submenu (not a plain toggle) so
   * the always-on "disconnesso" choice reads as a distinct, deliberate state
   * from "auto"'s automatic, temporary suspension while a full-screen
   * program owns the shell. */
  function linkModeItem(): ContextMenuItem {
    return {
      label: "Collegamento al terminale",
      icon: Icons.link,
      submenu: [
        { label: "Connesso", checked: linkMode === "auto", onSelect: () => onSetLinkMode("auto") },
        { label: "Scollegato", checked: linkMode === "disconnesso", onSelect: () => onSetLinkMode("disconnesso") },
      ],
    };
  }

  function backgroundMenuItems(): ContextMenuItem[] {
    return [
      { label: "Nuovo file", icon: Icons.newFile, onSelect: () => setCreating("file") },
      { label: "Nuova cartella", icon: Icons.newFolder, onSelect: () => setCreating("dir") },
      { separator: true, label: "sep-bg1" },
      linkModeItem(),
    ];
  }

  function headerMenuItems(): ContextMenuItem[] {
    const cwdFav = cwd ? isFavorite(cwd) : false;
    // Saving "the current folder" only makes sense while it actually
    // reflects the terminal's real cwd - once a full-screen program (Claude
    // Code, Codex, vim...) owns the shell, the explorer may be browsing
    // somewhere the shell never actually visited.
    const canFavoriteCurrent = !!cwd && !terminalBusy;
    return [
      { label: "Mostra file nascosti", icon: Icons.eye, checked: showHidden, onSelect: toggleShowHidden },
      { separator: true, label: "sep-h1" },
      {
        label: cwdFav ? "Rimuovi cartella corrente dai preferiti" : "Aggiungi cartella corrente ai preferiti",
        icon: Icons.star,
        disabled: !canFavoriteCurrent,
        onSelect: () => cwd && (cwdFav ? removeFavorite(cwd) : addFavorite(cwd)),
      },
      { separator: true, label: "sep-h2" },
      linkModeItem(),
      { separator: true, label: "sep-h2b" },
      { label: "Nuovo file", icon: Icons.newFile, onSelect: () => setCreating("file") },
      { label: "Nuova cartella", icon: Icons.newFolder, onSelect: () => setCreating("dir") },
      { separator: true, label: "sep-h3" },
      { label: "Aggiorna", icon: Icons.refresh, onSelect: reload },
    ];
  }

  const isSearching = searchOpen && searchQuery.trim().length > 0;
  const visibleEntries = isSearching ? searchResults : entries;

  /** The folder a recursive-search match sits in, relative to `cwd` - shown
   * next to the name so results from different subfolders (possibly
   * sharing a filename) stay distinguishable. Empty for a direct child. */
  function resultDir(entry: FsEntry): string {
    if (!cwd) return "";
    // `cwd`/`entry.path` come straight from Rust's `Path::to_string_lossy`
    // (see fs.rs's `read_dir`/`search_dir`), which is backslash-separated on
    // Windows - a hardcoded "/" prefix here never matched there, so this
    // path line silently never showed on Windows at all. Sniffed from `cwd`
    // itself rather than assumed from the platform, so a WSL UNC cwd
    // (`\\wsl.localhost\...`, still backslash-separated) works the same way.
    const sep = cwd.includes("\\") ? "\\" : "/";
    const cwdPrefix = cwd.replace(/[\\/]+$/, "") + sep;
    if (!entry.path.startsWith(cwdPrefix)) return "";
    const rel = entry.path.slice(cwdPrefix.length, entry.path.length - entry.name.length - 1);
    return rel;
  }

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <button
          type="button"
          className="file-tree-back"
          aria-label="Cartella superiore"
          title="Cartella superiore"
          disabled={isRootPath(cwd)}
          onClick={goUp}
        >
          {Icons.back}
        </button>
        {renamingPath === cwd ? (
          <input
            ref={headerRenameInputRef}
            className="file-tree-header-rename-input"
            value={headerRenameDraft}
            onChange={(e) => setHeaderRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitPathEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPathEdit();
              if (e.key === "Escape") setRenamingPath(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="file-tree-header-label"
            title={cwd}
            onClick={() => cwd && handleCopyPath(cwd)}
            onDoubleClick={startEditPath}
          >
            {truncatePath(cwd)}
          </button>
        )}
        <button
          type="button"
          className={"file-tree-menu-btn" + (searchOpen ? " is-active" : "")}
          aria-label="Cerca nella cartella e nelle sottocartelle"
          title="Cerca nella cartella e nelle sottocartelle"
          onClick={toggleSearch}
        >
          {Icons.search}
        </button>
        <button
          type="button"
          className="file-tree-menu-btn"
          aria-label="Opzioni cartella"
          title="Opzioni cartella"
          onClick={(e) => openMenu(e, headerMenuItems())}
        >
          {Icons.kebab}
        </button>
      </div>
      {searchOpen && (
        <div className="file-tree-search">
          <span className="file-tree-search-icon">{Icons.search}</span>
          <input
            ref={searchInputRef}
            className="file-tree-search-input"
            placeholder="Cerca file o cartelle, anche nelle sottocartelle…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") toggleSearch();
            }}
          />
        </div>
      )}
      <div className="file-tree-list" onContextMenu={(e) => openMenu(e, backgroundMenuItems())}>
        {error && <div className="file-tree-loading">{error}</div>}
        {!error && !isSearching && entries === null && <div className="file-tree-loading">Loading…</div>}
        {!error && isSearching && searching && searchResults === null && (
          <div className="file-tree-loading">Ricerca in corso…</div>
        )}
        {!error &&
          visibleEntries?.map((entry) =>
            renamingPath === entry.path ? (
              <InlineEditRow
                key={entry.path}
                icon={<EntryIcon entry={entry} />}
                initialValue={entry.name}
                onCommit={(value) => commitRename(entry, value)}
                onCancel={() => setRenamingPath(null)}
              />
            ) : (
              <div
                key={entry.path}
                className={"file-tree-row" + (selected === entry.path ? " is-active" : "")}
                onClick={() => handleRowClick(entry)}
                onDoubleClick={() => !entry.is_dir && onOpenFile(entry.path)}
                onContextMenu={(e) => openMenu(e, entryMenuItems(entry))}
              >
                <EntryIcon entry={entry} />
                <div className="file-tree-name-col">
                  <span className="file-tree-name">{entry.name}</span>
                  {isSearching && resultDir(entry) && (
                    <span className="file-tree-result-path" title={resultDir(entry)}>
                      {resultDir(entry)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={"file-tree-copy-btn" + (copiedPath === entry.path ? " is-copied" : "")}
                  aria-label={`Copia percorso di ${entry.name}`}
                  title="Copia percorso"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyPath(entry.path);
                  }}
                >
                  {copiedPath === entry.path ? Icons.smallCheck : Icons.smallCopy}
                </button>
              </div>
            ),
          )}
        {creating && (
          <InlineEditRow
            icon={creating === "dir" ? <FolderGlyph /> : <FileTypeIcon name="nuovo-file.txt" />}
            initialValue={creating === "dir" ? "nuova cartella" : "nuovo-file.txt"}
            allowUnchanged
            onCommit={(value) => commitCreate(creating, value)}
            onCancel={() => setCreating(null)}
          />
        )}
        {!error && visibleEntries?.length === 0 && !creating && !(isSearching && searching && searchResults === null) && (
          <div className="file-tree-loading">{isSearching ? "Nessun risultato" : "Cartella vuota"}</div>
        )}
      </div>
      {toast && (
        <div className="file-tree-toast">
          {Icons.smallCheck}
          {toast}
        </div>
      )}
      {infoEntry && (
        <FileInfoDialog
          path={infoEntry.path}
          name={infoEntry.name}
          isDir={infoEntry.is_dir}
          onClose={() => setInfoEntry(null)}
        />
      )}
    </div>
  );
}
