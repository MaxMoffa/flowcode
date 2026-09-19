import { useSyncExternalStore } from "react";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { addFavorite, listFavorites, removeFavorite, subscribeFavorites } from "./favoritesStore";
import "./favorites.css";

interface FavoritesButtonProps {
  /** The active terminal's real cwd, if any - lets "Aggiungi cartella
   * corrente" show up straight from this button, without going through the
   * file explorer first. */
  activeCwd?: string;
  onOpenFolder: (path: string) => void;
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" stroke="currentColor" fill="none">
      <path d="M12 3.8l2.35 4.9 5.35.68-3.9 3.75.98 5.37L12 15.9l-4.78 2.6.98-5.37-3.9-3.75 5.35-.68z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" stroke="currentColor" fill="none">
      <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" width="14" height="14" stroke="currentColor" fill="none">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** Header quick-access to folders pinned as favorites - addable from here
 * (current terminal folder), from the file explorer's own context menu, or
 * removable straight from this menu. Left click and right click behave the
 * same: both just open the list, there's nothing hidden behind a second
 * gesture. */
export function FavoritesButton({ activeCwd, onOpenFolder }: FavoritesButtonProps) {
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const { show, hide } = useContextMenu();

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [];

    if (activeCwd) {
      items.push({
        label: "Aggiungi cartella corrente",
        icon: <AddIcon />,
        onSelect: () => addFavorite(activeCwd),
      });
      if (favorites.length > 0) items.push({ separator: true, label: "sep-add" });
    }

    if (favorites.length === 0 && !activeCwd) {
      items.push({ label: "Nessun preferito", disabled: true, onSelect: undefined });
    }

    favorites.forEach((fav) => {
      items.push({
        label: `fav-${fav.path}`,
        custom: (
          <div
            className="favorites-row"
            onClick={() => {
              hide();
              onOpenFolder(fav.path);
            }}
            title={fav.path}
          >
            <span className="context-menu-icon">
              <FolderIcon />
            </span>
            <span className="context-menu-label">{fav.name}</span>
            <button
              type="button"
              className="favorites-row-remove"
              aria-label={`Rimuovi ${fav.name} dai preferiti`}
              onClick={(ev) => {
                ev.stopPropagation();
                removeFavorite(fav.path);
                hide();
              }}
            >
              <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        ),
      });
    });

    show(e.clientX, e.clientY, items);
  }

  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Preferiti"
      title="Preferiti"
      onClick={openMenu}
      onContextMenu={openMenu}
    >
      <StarIcon />
    </button>
  );
}
