import { createContext, useContext } from "react";
import { localFavorites, type FavoritesStore } from "./favoritesStore";

/** The favorites the explorer menus edit: this PC's by default, another PC's under its workspace. */
export const FavoritesContext = createContext<FavoritesStore>(localFavorites);
export const useFavorites = () => useContext(FavoritesContext);
