import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useOpenContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { FileTypeIcon } from "./fileIcons";
import { FileInfoDialog } from "./FileInfoDialog";

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

function iconSvg(children: ReactElement) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      {children}
    </svg>
  );
}

const Icons = {
  open: iconSvg(<><rect x="4" y="6" width="16" height="13" rx="1.6" /><path d="M4 9h16" /></>),
  reveal: iconSvg(<><path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" /></>),
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
      <svg viewBox="0 0 24 24" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" stroke="currentColor" fill="none">
        <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
      </svg>
    </span>
  );
}

function EntryIcon({ entry }: { entry: FsEntry }) {
  return entry.is_dir ? <FolderGlyph /> : <FileTypeIcon name={entry.name} />;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
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

const SHOW_HIDDEN_KEY = "flowcode.showHiddenFiles";

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

interface FileTreeProps {
  cwd: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal: (path: string) => void;
}

export function FileTree({ cwd, onNavigate, onOpenFile, onOpenTerminal }: FileTreeProps) {
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
      if (open) setSearchQuery("");
      return !open;
    });
  }

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
    items.push({
      label: "Rivela nel file manager",
      icon: Icons.reveal,
      onSelect: () => revealItemInDir(entry.path).catch(() => {}),
    });
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

  function backgroundMenuItems(): ContextMenuItem[] {
    return [
      { label: "Nuovo file", icon: Icons.newFile, onSelect: () => setCreating("file") },
      { label: "Nuova cartella", icon: Icons.newFolder, onSelect: () => setCreating("dir") },
    ];
  }

  function headerMenuItems(): ContextMenuItem[] {
    return [
      { label: "Mostra file nascosti", icon: Icons.eye, checked: showHidden, onSelect: toggleShowHidden },
      { separator: true, label: "sep-h1" },
      { label: "Nuovo file", icon: Icons.newFile, onSelect: () => setCreating("file") },
      { label: "Nuova cartella", icon: Icons.newFolder, onSelect: () => setCreating("dir") },
      { separator: true, label: "sep-h2" },
      { label: "Aggiorna", icon: Icons.refresh, onSelect: reload },
    ];
  }

  const visibleEntries =
    searchOpen && searchQuery.trim()
      ? entries?.filter((entry) => entry.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
      : entries;

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <button
          type="button"
          className="file-tree-back"
          aria-label="Cartella superiore"
          title="Cartella superiore"
          disabled={!cwd || cwd === "/"}
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
          aria-label="Cerca nella cartella"
          title="Cerca nella cartella"
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
          <input
            ref={searchInputRef}
            className="file-tree-search-input"
            placeholder="Cerca file o cartelle…"
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
        {!error && entries === null && <div className="file-tree-loading">Loading…</div>}
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
                <span className="file-tree-name">{entry.name}</span>
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
        {!error && visibleEntries?.length === 0 && !creating && (
          <div className="file-tree-loading">{searchOpen && searchQuery.trim() ? "Nessun risultato" : "Cartella vuota"}</div>
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
