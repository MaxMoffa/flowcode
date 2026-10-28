import { showToast } from "./remote";
import { t } from "./i18n";
import { createStore } from "./store";

/** What the phone asked the desktop for and is still waiting on. */
export interface Pending {
  /** A new terminal/chat ("open"), or a chat turned into a terminal / a terminal into a chat. */
  kind: "open" | "toTerminal" | "toChat";
  /** "open" only: whether it is a chat. */
  asChat: boolean;
  /** What is being opened ("Claude Code · flowcode"); empty for a handoff. */
  label: string;
  since: number;
  /** The desktop never answered; shown for a moment, then dropped. */
  failed: boolean;
}

const store = createStore<{ pending: Pending | null }>({ pending: null });
/** How long the "didn't answer" notice of a new terminal/chat stays. */
const FAILED_MS = 4000;
let timer: ReturnType<typeof setTimeout> | undefined;

export const usePending = (): Pending | null => store.useSelector((s) => s.pending);

/** Starts waiting (replacing any earlier wait); gives up after `waitMs`. */
export function beginPending(p: Pick<Pending, "kind" | "label"> & { asChat?: boolean }, waitMs: number) {
  clearTimeout(timer);
  store.set({ pending: { asChat: false, ...p, since: Date.now(), failed: false } });
  timer = setTimeout(() => {
    const cur = store.get().pending;
    if (!cur) return;
    if (cur.kind !== "open") {
      showToast(t("openTimeout"));
      store.set({ pending: null });
      return;
    }
    store.set({ pending: { ...cur, failed: true } });
    timer = setTimeout(() => store.set({ pending: null }), FAILED_MS);
  }, waitMs);
}

/** The desktop answered (or the request is moot). */
export function endPending() {
  clearTimeout(timer);
  if (store.get().pending) store.set({ pending: null });
}
