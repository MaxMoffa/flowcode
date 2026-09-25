import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { addFavorite, listFavorites, removeFavorite, subscribeFavorites, type FavoriteFolder } from "./favoritesStore";
import { useI18n } from "../i18n";
import "./favorites.css";

interface FavoritesButtonProps {
  /** The active terminal's real cwd, if any - lets "Aggiungi cartella
   * corrente" show up straight from this button, without going through the
   * file explorer first. */
  activeCwd?: string;
  /** Shell id of the active terminal - saved alongside `activeCwd`. */
  activeShell?: string;
  onOpenFolder: (favorite: FavoriteFolder) => void;
}

export function StarIcon() {
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

interface FavoritesMenuContentProps {
  /** The active terminal's real cwd, if any - lets the footer's "Aggiungi
   * cartella corrente" row show up straight from this menu. */
  activeCwd?: string;
  /** Shell id of the active terminal - saved alongside `activeCwd`, see
   * `FavoriteFolder.shell`. */
  activeShell?: string;
  onOpenFolder: (favorite: FavoriteFolder) => void;
  /** Closes whichever menu (top-level or flyout) this content ends up
   * rendered in. */
  hide: () => void;
}

/** The favorites menu's full body - shared by the header's own
 * FavoritesButton and App.tsx's top-right "..." menu (a "Preferiti" submenu
 * entry there), as a single self-contained component rather than a plain
 * list of ContextMenuItems: a search box (same idea as the stacked-tabs
 * overflow popup's own "Cerca tab…") needs to filter the list live as the
 * user types, which a static items array handed to ContextMenuProvider at
 * open time can't do - and subscribing to the favorites store directly here
 * (rather than taking `favorites` as a prop computed once at open time)
 * means both call sites stay live if a favorite is added/removed elsewhere
 * while the menu is open. */
function FavoritesMenuContent({ activeCwd, activeShell, onOpenFolder, hide }: FavoritesMenuContentProps) {
  const { t } = useI18n();
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = favorites.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="favorites-menu-content">
      <input
        ref={inputRef}
        type="text"
        className="favorites-search"
        placeholder={t("favorites.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="favorites-list">
        {favorites.length === 0 && <div className="favorites-empty">{t("favorites.empty")}</div>}
        {favorites.length > 0 && filtered.length === 0 && <div className="favorites-empty">{t("common.noResults")}</div>}
        {filtered.map((fav) => (
          <div
            key={fav.path}
            className="favorites-row"
            onClick={() => {
              hide();
              onOpenFolder(fav);
            }}
            title={fav.shell?.startsWith("wsl") ? `${fav.path} (WSL)` : fav.path}
          >
            <span className="context-menu-icon">
              <FolderIcon />
            </span>
            <span className="context-menu-label">{fav.name}</span>
            <button
              type="button"
              className="favorites-row-remove"
              aria-label={t("favorites.removeNamed", { name: fav.name })}
              onClick={(ev) => {
                ev.stopPropagation();
                // Same rule as the stacked-tabs overflow popup: only close
                // the whole menu if this was the last row on screen,
                // otherwise stay open so several can be removed in a row.
                if (filtered.length === 1) hide();
                removeFavorite(fav.path);
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
      {activeCwd && (
        <div className="favorites-footer">
          <div
            className="favorites-row"
            onClick={() => {
              hide();
              addFavorite(activeCwd, activeShell);
            }}
          >
            <span className="context-menu-icon">
              <AddIcon />
            </span>
            <span className="context-menu-label">{t("favorites.addCurrentShort")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** `ContextMenuItem` wrapper around `FavoritesMenuContent`, for the two call
 * sites that hand it to `show()`/a `submenu` array. */
export function favoritesMenuItem(props: FavoritesMenuContentProps): ContextMenuItem {
  return { label: "favorites-content", custom: <FavoritesMenuContent {...props} /> };
}

/** Header quick-access to folders pinned as favorites - addable from here
 * (current terminal folder), from the file explorer's own context menu, or
 * removable straight from this menu. Left click and right click behave the
 * same: both just open the list, there's nothing hidden behind a second
 * gesture. */
export function FavoritesButton({ activeCwd, activeShell, onOpenFolder }: FavoritesButtonProps) {
  const { t } = useI18n();
  const { show, hide } = useContextMenu();

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    show(e.clientX, e.clientY, [favoritesMenuItem({ activeCwd, activeShell, onOpenFolder, hide })]);
  }

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={t("favorites.title")}
      title={t("favorites.title")}
      onClick={openMenu}
      onContextMenu={openMenu}
    >
      <StarIcon />
    </button>
  );
}
