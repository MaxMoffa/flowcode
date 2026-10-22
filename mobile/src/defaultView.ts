import { CHAT_VIEW } from "./ChatMenu";
import { createStore, safeStorage } from "./store";

/** Storage key per layout: a tablet and a phone (or a foldable in either shape) each keep their own. */
const key = (wide: boolean) => (wide ? "chat.defaultView.tablet" : "chat.defaultView.phone");

const read = (wide: boolean): string => safeStorage.get(key(wide)) || CHAT_VIEW;

/** Device-local, not mirrored to the desktop: the view a chat opens with here. */
const store = createStore<{ phone: string; tablet: string }>({ phone: read(false), tablet: read(true) });

export const defaultViewFor = (wide: boolean): string => (wide ? store.get().tablet : store.get().phone);

export function setDefaultView(wide: boolean, id: string) {
  safeStorage.set(key(wide), id);
  store.set(wide ? { tablet: id } : { phone: id });
}

export const useDefaultView = (wide: boolean): string => store.useSelector((s) => (wide ? s.tablet : s.phone));
