import { createStore, safeStorage } from "./store";

const KEY = "wide.uiScale";

type UiScale = "compact" | "normal" | "large";
/** CSS `zoom` of the wide layout's chrome (never the terminal): compact is the original size. */
const ZOOM: Record<UiScale, number> = { compact: 1, normal: 1.15, large: 1.3 };

const read = (): UiScale => {
  const v = safeStorage.get(KEY);
  return v === "compact" || v === "large" ? v : "normal";
};

/** Phone-local, not mirrored to the desktop. */
const store = createStore<{ scale: UiScale }>({ scale: read() });

export function setUiScale(scale: UiScale) {
  safeStorage.set(KEY, scale);
  store.set({ scale });
}

export const useUiScale = (): UiScale => store.useSelector((s) => s.scale);
export const useUiZoom = (): number => ZOOM[useUiScale()];
