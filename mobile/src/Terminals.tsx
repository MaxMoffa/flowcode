import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SWEEP_DASHES } from "../../shared/busySweep";
import { pendingPermissionTitle, requestOpenChat, useChatSession, useOpenNewChat } from "./chats";
import { contextPercent, shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, ChatIcon, ChevronIcon, PlusIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import { useRemoteSelector, type ChatInfo, type Tab } from "./remote";

/** How long a requested terminal is waited for before giving up on opening it. */
const NEW_TAB_WAIT_MS = 15_000;

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

function stateLabel(st: string): string {
  return st === "waiting" ? t("statusWaiting") : st === "busy" ? t("statusBusy") : t("statusIdle");
}

/** A chat session: the agent's logo with a speech bubble on it, its state, and what it asks while it waits. Opened through the chat store, which App listens to. */
export function ChatRow({ chat }: { chat: ChatInfo }) {
  const session = useChatSession(chat.chatId);
  const st = chat.status === "waiting" ? "waiting" : chat.status === "busy" ? "busy" : "idle";
  const asks = st === "waiting" ? pendingPermissionTitle(session) : undefined;
  const label = chat.status === "starting" ? t("chatStateStarting") : chat.status === "exited" ? t("chatStateExited") : stateLabel(st);
  return (
    <button type="button" className="tr-row" onClick={() => requestOpenChat(chat.chatId)}>
      <span className={"tr-ico is-" + st}>
        <AgentLogo cli={chat.agent} size={17} />
        <i className="tr-bubble" aria-hidden="true">
          <ChatIcon size={11} />
        </i>
        {st === "busy" && <BusyArc />}
      </span>
      <span className="tr-body">
        <b className="tr-title">{chat.label}</b>
        <span className="tr-line">
          <span className={"tr-state is-" + st}>{label[0].toUpperCase() + label.slice(1)}</span>
          <span className="tr-sub mono">· {asks ? t("chatAsks", { title: asks }) : shortCwd(chat.cwd)}</span>
        </span>
      </span>
      <ChevronIcon />
    </button>
  );
}

function TermRow({ tab, onOpen }: { tab: Tab; onOpen: (ptyId: string) => void }) {
  const st = tab.cli ? (tab.status ?? "idle") : null;
  const pct = tab.cli ? contextPercent(tab) : null;
  return (
    <button type="button" className="tr-row" onClick={() => onOpen(tab.ptyId)}>
      <span className={"tr-ico" + (st ? " is-" + st : "")}>
        {(tab.cli && <AgentLogo cli={tab.cli} size={17} />) || <TerminalIcon />}
        {st === "busy" && <BusyArc />}
      </span>
      <span className="tr-body">
        <b className="tr-title">{tab.label}</b>
        {st ? (
          <span className="tr-line">
            <span className={"tr-state is-" + st}>{stateLabel(st)}</span>
            <span className="tr-sub mono">· {pct !== null ? t("contextPct", { n: pct }) : shortCwd(tab.cwd)}</span>
          </span>
        ) : (
          <span className="tr-sub mono">{shortCwd(tab.cwd)}</span>
        )}
      </span>
      <ChevronIcon />
    </button>
  );
}

/** A row of the list: a terminal or a chat session. */
type Entry = { kind: "tab"; tab: Tab } | { kind: "chat"; chat: ChatInfo };

/** The entries by desktop window, the main one first; the others are numbered in the order the desktop lists them. */
function byWindow(entries: Entry[]): { key: string; title: string; entries: Entry[] }[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const window = entry.kind === "tab" ? entry.tab.window : entry.chat.window;
    const list = groups.get(window);
    if (list) list.push(entry);
    else groups.set(window, [entry]);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : 0));
  let n = 1;
  return sorted.map(([key, list]) => ({ key, title: key === "main" ? t("windowMain") : t("windowN", { n: ++n }), entries: list }));
}

/** A requested terminal opens as soon as the desktop lists it; returns the `onCreate` callback for NewTerminalSheet. */
export function useOpenNewTab(tabs: Tab[] | null, onOpen: (ptyId: string) => void): () => void {
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
      onOpen(fresh.ptyId);
    }
  }, [tabs, onOpen]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  return useCallback(() => {
    pendingRef.current = { known: new Set((tabsRef.current ?? []).map((x) => x.ptyId)), until: Date.now() + NEW_TAB_WAIT_MS };
  }, []);
}

/** A requested terminal or chat opens as soon as the desktop lists it; returns the `onCreate` callback for NewTerminalSheet. */
export function useOpenNew(tabs: Tab[] | null, onOpen: (ptyId: string) => void): (asChat: boolean) => void {
  const chats = useRemoteSelector((r) => r.chats);
  const onTab = useOpenNewTab(tabs, onOpen);
  const onChat = useOpenNewChat(chats, requestOpenChat);
  return useCallback((asChat) => (asChat ? onChat() : onTab()), [onTab, onChat]);
}

export function TerminalsScreen({ hostName, tabs, onOpen }: { hostName?: string; tabs: Tab[] | null; onOpen: (ptyId: string) => void }) {
  const chats = useRemoteSelector((r) => r.chats);
  const all = useMemo(() => tabs ?? [], [tabs]);
  // Chats waiting for an answer lead the page; the rest sit in their window with the terminals.
  const needYou = useMemo(() => (chats ?? []).filter((c) => c.status === "waiting"), [chats]);
  const entries = useMemo<Entry[]>(
    () => [...all.map((tab): Entry => ({ kind: "tab", tab })), ...(chats ?? []).filter((c) => c.status !== "waiting").map((chat): Entry => ({ kind: "chat", chat }))],
    [all, chats],
  );
  const groups = useMemo(() => byWindow(entries), [entries]);
  const total = all.length + (chats?.length ?? 0);
  const folders = useMemo(() => [...new Set([...all.map((x) => x.cwd), ...(chats ?? []).map((c) => c.cwd)].filter(Boolean))], [all, chats]);
  const [sheet, setSheet] = useState(false);
  const onCreate = useOpenNew(tabs, onOpen);

  return (
    <>
      <header className="th">
        <span className="th-text">
          <h1>{t("terminals")}</h1>
          {tabs !== null && (
            <span className="th-sub">
              {hostName ? `${hostName} · ` : ""}
              {total === 1 ? t("openCountOne") : t("openCount", { n: total })}
            </span>
          )}
        </span>
        <button type="button" className="th-new" onClick={() => setSheet(true)}>
          <PlusIcon />
          {t("newTerminalShort")}
        </button>
      </header>
      {tabs !== null && total === 0 && <div className="empty">{t("noTabs")}</div>}
      {needYou.length > 0 && (
        <section className="tr-group">
          <div className="tr-ghead is-wait">
            <b>{t("needYou")}</b>
            <span>{needYou.length}</span>
          </div>
          <div className="card tr-list">
            {needYou.map((c) => (
              <ChatRow key={c.chatId} chat={c} />
            ))}
          </div>
        </section>
      )}
      {groups.map((g) => (
        <section className="tr-group" key={g.key}>
          <div className="tr-ghead">
            <b>{g.title}</b>
            <span>{g.entries.length === 1 ? t("tabCountOne") : t("tabCount", { n: g.entries.length })}</span>
          </div>
          <div className="card tr-list">
            {g.entries.map((e) => (e.kind === "tab" ? <TermRow key={e.tab.ptyId} tab={e.tab} onOpen={onOpen} /> : <ChatRow key={e.chat.chatId} chat={e.chat} />))}
          </div>
        </section>
      ))}
      <NewTerminalSheet
        open={sheet}
        folders={folders}
        onClose={() => setSheet(false)}
        onCreate={onCreate}
      />
    </>
  );
}
