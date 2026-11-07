// Whether the file explorer and the folder picker list hidden entries: off by default, remembered on the phone.
import type { LsEntry } from "../../shared/remote-types";
import { createStore, safeStorage } from "./store";

const KEY = "files.showHidden";
const store = createStore({ show: safeStorage.get(KEY) === "1" });

/** A dot-file, or one the desktop marks hidden (the Windows attribute). */
export const isHidden = (entry: LsEntry) => entry.hidden === true || entry.name.startsWith(".");

export const useShowHidden = () => store.useSelector((s) => s.show);

export function setShowHidden(show: boolean) {
  safeStorage.set(KEY, show ? "1" : "0");
  store.set({ show });
}
