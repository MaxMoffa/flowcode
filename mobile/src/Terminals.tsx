import { useCallback, useEffect, useRef } from "react";
import { SWEEP_DASHES } from "../../shared/busySweep";
import { requestOpenChat, useOpenNewChat } from "./chats";
import { t } from "./i18n";
import { ChatIcon, TerminalIcon } from "./icons";
import { beginPending, endPending, usePending, type Pending } from "./pending";
import { useRemoteSelector, type Tab } from "./remote";

/** How long a requested terminal is waited for before giving up on opening it. */
const NEW_TAB_WAIT_MS = 15_000;
const CHAT_WAIT_MS = 45_000;

/** The arc running round a busy agent's icon, as on the desktop's tabs; `rx` and `className` for one running round a whole tab (WideShell). */
export function BusyArc({ rx = 9, className = "tr-sweep" }: { rx?: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      {SWEEP_DASHES.map((d, i) => (
        <rect key={i} width="100%" height="100%" rx={rx} pathLength="100" style={{ strokeDasharray: d.dasharray, opacity: d.opacity }} />
      ))}
    </svg>
  );
}

function useOpenNewTab(tabs: Tab[] | null, onOpen: (ptyId: string) => void): () => void {
  /** The tabs known when asking, and until when to wait. */
  const pendingRef = useRef<{ known: Set<string>; until: number } | null>(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !tabs) return;
    if (Date.now() > p.until) {
      pendingRef.current = null;
      return;
    }
    const fresh = tabs.find((x) => !p.known.has(x.ptyId));
    if (fresh) {
      pendingRef.current = null;
      endPending();
      onOpen(fresh.ptyId);
    }
  }, [tabs, onOpen]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  return useCallback(() => {
    pendingRef.current = { known: new Set((tabsRef.current ?? []).map((x) => x.ptyId)), until: Date.now() + NEW_TAB_WAIT_MS };
  }, []);
}

/** A requested terminal or chat opens as soon as the desktop lists it; returns the `onCreate` callback for NewTerminalSheet (a chat can carry a `firstPrompt` to send once it is ready) and what is being waited on (for `PendingRow`). */
export function useOpenNew(tabs: Tab[] | null, onOpen: (ptyId: string) => void): { onCreate: (asChat: boolean, label: string, firstPrompt?: string, expect?: { agent: string; cwd?: string }) => void; pending: Pending | null } {
  const chats = useRemoteSelector((r) => r.chats);
  const onTab = useOpenNewTab(tabs, onOpen);
  const onChat = useOpenNewChat(chats, requestOpenChat);
  const pending = usePending();
  const onCreate = useCallback(
    (asChat: boolean, label: string, firstPrompt?: string, expect?: { agent: string; cwd?: string }) => {
      // A chat waits as long as `useOpenNewChat` does (its agent starts first).
      beginPending({ kind: "open", asChat, label }, asChat ? CHAT_WAIT_MS : NEW_TAB_WAIT_MS);
      if (asChat) onChat(firstPrompt, expect);
      else onTab();
    },
    [onTab, onChat],
  );
  return { onCreate, pending: pending?.kind === "open" ? pending : null };
}

/** The row at the top of the list while the desktop opens a requested terminal or chat; a muted notice if it never answers. */
export function PendingRow({ pending }: { pending: Pending | null }) {
  if (!pending) return null;
  return (
    <section className="tr-group">
      <div className="card tr-list">
        <div className={"tr-row tr-pending" + (pending.failed ? " is-failed" : "")} role="status">
          <span className="tr-ico">{pending.failed ? pending.asChat ? <ChatIcon size={17} /> : <TerminalIcon /> : <span className="pend-spinner" aria-hidden="true" />}</span>
          <span className="tr-body">
            <b className="tr-title">{pending.failed ? t("openTimeout") : t("opening", { name: pending.label })}</b>
            {!pending.failed && <span className="tr-sub">{t("openingOnComputer")}</span>}
          </span>
        </div>
      </div>
    </section>
  );
}
