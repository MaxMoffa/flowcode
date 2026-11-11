import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./home.css";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { FolderPicker } from "./FolderPicker";
import { launchPath } from "./explorerPaths";
import { useBackHandler, useEscape } from "./back";
import { closeChatTab, pendingPermissionTitle, renameChat, requestOpenChat, useChatSession } from "./chats";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { agentName, shortCwd } from "./common";
import { tapFeedback } from "./haptics";
import { groupSessions, lastInWindow, sessionsOf, useStateSince, type Session } from "./homeSessions";
import { leftText } from "./homeUsage";
import { UsageSection } from "./HomeUsageCards";
import { t } from "./i18n";
import { AgentLogo, ArrowUpRightIcon, ChatIcon, CheckIcon, ChevronDownIcon, CloseIcon, DotsIcon, FolderIcon, PencilIcon, PlusIcon, SendIcon, TerminalIcon } from "./icons";
import { AGENTS, loadRecents, recentsKey, NewTerminalSheet } from "./NewTerminalSheet";
import type { Pending } from "./pending";
import { send, useRemoteSelector, useSupports, type Tab } from "./remote";
import { safeStorage } from "./store";
import { BusyArc, PendingRow, useOpenNew } from "./Terminals";

const AGENT_KEY = "home.agent";
const cwdKey = (host: string | undefined) => "home.cwd." + (host ?? "");

/** "6 min" / "2 h 05" once a minute has passed, else null (the label says "now"). */
function sinceText(ms: number): string | null {
  return ms < 60_000 ? null : leftText(ms);
}

const stateLabel = (s: Session): string => (s.status === "waiting" ? t("statusWaiting") : s.status === "busy" ? t("statusBusy") : s.status === "idle" ? t("statusIdle") : s.status === "starting" ? t("homeStarting") : t("chatStateExited"));

/** The agent's logo on a state-coloured tile: the busy arc runs round working agents (green while starting), a bubble marks chats. */
function SessionTile({ s }: { s: Session }) {
  return (
    <span className={"hm-tile st-" + s.status}>
      <AgentLogo cli={s.cli} size={20} />
      {(s.status === "busy" || s.status === "starting") && <BusyArc rx={12} />}
      {s.kind === "chat" && (
        <span className="hm-bubble" aria-hidden="true">
          <ChatIcon size={11} />
        </span>
      )}
    </span>
  );
}

/** A small picker sheet: one radio list, the choice closes it. */
/** The launcher's agent menu: anchored to its pill (below, or above when the keyboard leaves no room), portalled so the blurred card cannot clip it. */
function AgentMenu({ anchor, options, value, onPick, onClose }: { anchor: HTMLElement | null; options: { value: string; label: string; icon: ReactNode }[]; value: string; onPick: (v: string) => void; onClose: () => void }) {
  useBackHandler(true, onClose);
  useEscape(true, onClose);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      if (!menu.current) return;
      if (!anchor) {
        setPos({ left: 8, top: (window.visualViewport?.offsetTop ?? 0) + 8 });
        return;
      }
      const r = anchor.getBoundingClientRect();
      const h = menu.current.offsetHeight;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.current.offsetWidth - 8));
      const below = r.bottom + 6;
      const above = r.top - 6 - h;
      const top = below + h <= viewportBottom - 8 || above < viewportTop + 8 ? below : above;
      setPos({ left, top: Math.max(viewportTop + 8, Math.min(top, viewportBottom - h - 8)), transformOrigin: top === above ? "bottom left" : "top left" });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor]);
  return createPortal(
    <>
      <div className="hm-menu-scrim" onClick={onClose} />
      <div ref={menu} className="hm-menu" role="radiogroup" aria-label={t("newTermAgent")} style={pos}>
        <small>{t("newTermAgent")}</small>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onPick(o.value)}>
            {o.icon}
            <span>{o.label}</span>
            {o.value === value && <CheckIcon />}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** What was sent, kept until the desktop answers: a failed start gives it back, even to a Home mounted again. */
const sent = { current: "" };

/** The text field that starts a chat: what to do, with which agent, in which folder. */
export function Launcher({ hostName, tabs, onCreate, pending }: { hostName: string | undefined; tabs: Tab[] | null; onCreate: (asChat: boolean, label: string, firstPrompt?: string, expect?: { agent: string; cwd?: string }) => void; pending: Pending | null }) {
  const canGemini = useSupports("gemini");
  const canOpencode = useSupports("opencode");
  const chats = useRemoteSelector((r) => r.chats);
  const agents = useMemo(() => AGENTS.filter((a) => (a.id !== "gemini" || canGemini) && (a.id !== "opencode" || canOpencode)), [canGemini, canOpencode]);
  const key = cwdKey(hostName);
  const [agentId, setAgentId] = useState<string>(() => safeStorage.get(AGENT_KEY) ?? "");
  const [folder, setFolder] = useState(() => ({ key, cwd: safeStorage.get(key) || null }));
  if (folder.key !== key) setFolder({ key, cwd: safeStorage.get(key) || null });
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<"agent" | "folder" | null>(null);
  const agentPill = useRef<HTMLButtonElement>(null);

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const cwd = folder.cwd;

  useEffect(() => {
    if (!pending) sent.current = "";
    else if (pending.failed && sent.current) {
      const text = sent.current;
      sent.current = "";
      setDraft((d) => d || text);
    }
  }, [pending]);

  const folders = useMemo(() => {
    if (picker !== "folder") return [];
    const open = [...(tabs ?? []).map((x) => x.cwd), ...(chats ?? []).map((c) => c.cwd)];
    const recent = loadRecents(recentsKey(hostName)).map((r) => r.cwd);
    // The remembered folder stays offered even when nothing else points at it.
    return [...new Set([cwd, ...open, ...recent].filter((c): c is string => !!c))];
  }, [picker, tabs, chats, hostName, cwd]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !agent || (pending && !pending.failed)) return;
    sent.current = text;
    send({ t: "newchat", cli: agent.id, ...(cwd ? { cwd: launchPath(cwd) } : {}) });
    onCreate(true, cwd ? `${agent.name} · ${shortCwd(cwd)}` : agent.name, text, { agent: agent.id, ...(cwd ? { cwd: launchPath(cwd) } : {}) });
    setDraft("");
  };

  return (
    <section className="hm-launch">
      <textarea value={draft} placeholder={t("homePlaceholder")} aria-label={t("homePlaceholder")} onChange={(e) => setDraft(e.target.value)} />
      <div className="hm-bar">
        <button ref={agentPill} type="button" className={"hm-pill" + (picker === "agent" ? " on" : "")} aria-label={t("newTermAgent")} aria-haspopup="true" aria-expanded={picker === "agent"} onClick={() => setPicker("agent")}>
          {agent && <AgentLogo cli={agent.id} size={16} />}
          <span>{agent?.name}</span>
          <i className="hm-pill-chev" aria-hidden="true"><ChevronDownIcon /></i>
        </button>
        <button type="button" className="hm-pill mono" aria-label={t("newTermFolder")} onClick={() => setPicker("folder")}>
          <FolderIcon />
          <span>{cwd ? shortCwd(cwd) : t("newTermStartFolder")}</span>
        </button>
        <button type="button" className="hm-go" aria-label={t("homeStart")} disabled={!draft.trim() || (!!pending && !pending.failed)} onClick={submit}>
          <SendIcon />
        </button>
      </div>
      {picker === "agent" && (
        <AgentMenu
          anchor={agentPill.current}
          value={agent?.id ?? ""}
          options={agents.map((a) => ({ value: a.id as string, label: a.name, icon: <AgentLogo cli={a.id} size={18} /> }))}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            setAgentId(id);
            safeStorage.set(AGENT_KEY, id);
            setPicker(null);
          }}
        />
      )}
      {picker === "folder" && (
        <FolderPicker
          value={cwd}
          suggestions={folders}
          allowDefault
          onClose={() => setPicker(null)}
          onPick={(c) => {
            setFolder({ key, cwd: c });
            safeStorage.set(key, c ?? "");
            setPicker(null);
          }}
        />
      )}
    </section>
  );
}

function openSession(s: Session, onOpen: (ptyId: string) => void) {
  if (s.tab) onOpen(s.tab.ptyId);
  else if (s.chat) requestOpenChat(s.chat.chatId);
}

/** A session waiting for an answer: a terminal answers Yes / No right here, a chat asks to be opened (and says what it asks). */
function WaitCard({ s, waitedMs, onOpen }: { s: Session; waitedMs: number; onOpen: (ptyId: string) => void }) {
  const session = useChatSession(s.chat?.chatId ?? "");
  const asks = s.chat ? pendingPermissionTitle(session, s.chat) : undefined;
  const waited = sinceText(waitedMs);
  const eyebrow = asks ? t("chatAsks", { title: asks }) : t("homeWaiting");
  return (
    <section className="hm-wait">
      <div className="hm-wait-top">
        <SessionTile s={s} />
        <div className="hm-wait-text">
          <div className="hm-wait-eye">{waited ? `${eyebrow} · ${waited}` : eyebrow}</div>
          <div className="hm-wait-title">{s.label}</div>
          <div className="hm-wait-sub">
            {agentName(s.cli)} · <span className="mono">{shortCwd(s.cwd)}</span>
          </div>
        </div>
      </div>
      {s.tab ? (
        <div className="hm-wait-acts">
          <button
            type="button"
            className="hm-btn primary"
            onClick={() => {
              tapFeedback();
              send({ t: "input", ptyId: s.tab!.ptyId, data: "1" });
            }}
          >
            {t("yes")}
          </button>
          <button
            type="button"
            className="hm-btn"
            onClick={() => {
              tapFeedback();
              send({ t: "input", ptyId: s.tab!.ptyId, data: "\x1b" });
            }}
          >
            {t("no")}
          </button>
          <button type="button" className="hm-btn icon" aria-label={`${t("open")} ${s.label}`} onClick={() => openSession(s, onOpen)}>
            <ArrowUpRightIcon />
          </button>
        </div>
      ) : (
        <div className="hm-wait-acts single">
          <button type="button" className="hm-btn primary" onClick={() => openSession(s, onOpen)}>
            {t("homeReply")}
          </button>
        </div>
      )}
    </section>
  );
}

function SessionRow({ s, sinceMs, onOpen, onMenu }: { s: Session; sinceMs: number; onOpen: (ptyId: string) => void; onMenu: () => void }) {
  const waited = sinceText(sinceMs);
  return (
    <div className="hm-row">
      <button type="button" className="hm-row-main" onClick={() => openSession(s, onOpen)}>
        <SessionTile s={s} />
        <span className="hm-txt">
          <b>{s.label}</b>
          <span className="hm-sub">
            {agentName(s.cli)} · <span className="mono">{shortCwd(s.cwd)}</span>
            {s.contextPct !== null && s.contextPct >= 70 && (
              <>
                {" · "}
                <span className="warm">ctx {s.contextPct}%</span>
              </>
            )}
          </span>
        </span>
        <span className="hm-state">
          {s.status === "starting" ? (
            <em>{t("homeStarting")}</em>
          ) : (
            <>
              <span className="hm-vh">{stateLabel(s)}</span>
              <small>{waited ? t("homeSince", { time: waited }) : t("homeNow")}</small>
            </>
          )}
        </span>
      </button>
      <button type="button" className="hm-more" aria-label={t("homeSessionActions", { name: s.label })} onClick={onMenu}>
        <DotsIcon />
      </button>
    </div>
  );
}

/** What can be done to one session: open, rename, close (after a confirmation, not for the last tab of a window). */
function SessionSheet({ s, last, onOpen, onClose }: { s: Session; last: boolean; onOpen: (ptyId: string) => void; onClose: () => void }) {
  const canRename = useSupports(s.kind === "term" ? "rename" : "chatRename");
  const canClose = useSupports(s.kind === "term" ? "closeTab" : "chatCloseTab");
  const [mode, setMode] = useState<"menu" | "rename" | "confirm">("menu");
  const [draft, setDraft] = useState(s.label);
  useBackHandler(true, onClose);
  useEscape(true, onClose);

  const save = () => {
    const label = draft.trim();
    if (label && label !== s.label) {
      if (s.tab) send({ t: "rename", ptyId: s.tab.ptyId, label });
      else if (s.chat) renameChat(s.chat.chatId, label);
    }
    onClose();
  };
  const close = () => {
    if (s.tab) send({ t: "closetab", ptyId: s.tab.ptyId });
    else if (s.chat) closeChatTab(s.chat.chatId);
    onClose();
  };
  const confirmText = (s.kind === "chat" ? t("closeChatConfirm", { label: s.label }) : t("closeTerminalConfirm", { label: s.label })) + (s.status === "busy" ? " " + t("homeAgentWorking") : "");

  return (
    <AdaptiveSheet open family="nts" variant="dialog" onClose={onClose} label={s.label}>
      <div className="nts-grab" aria-hidden="true" />
      <h2>{s.label}</h2>
      <p className="hm-sheet-sub">
        {s.cli ? agentName(s.cli) : t("terminals")} · <span className="mono">{shortCwd(s.cwd)}</span>
      </p>
      <div className="nts-body">
        {mode === "menu" && (
          <div className="chat-menu-group">
            <button
              type="button"
              onClick={() => {
                openSession(s, onOpen);
                onClose();
              }}
            >
              <ArrowUpRightIcon />
              <span>{t("open")}</span>
            </button>
            {canRename && (
              <button type="button" onClick={() => setMode("rename")}>
                <PencilIcon />
                <span>{t("rename")}</span>
              </button>
            )}
            {canClose && (
              <button type="button" className="danger" disabled={last} onClick={() => setMode("confirm")}>
                <CloseIcon />
                <span>
                  {s.kind === "chat" ? t("chatCloseTab") : t("closeTerminal")}
                  {last && <small className="hm-opt-small">{t("homeLastTab")}</small>}
                </span>
              </button>
            )}
          </div>
        )}
        {mode === "rename" && (
          <div className="hm-rename">
            <input
              autoFocus
              value={draft}
              maxLength={128}
              enterKeyHint="done"
              aria-label={t("rename")}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <button type="button" className="hm-btn primary" disabled={!draft.trim()} onClick={save}>
              {t("profileSave")}
            </button>
          </div>
        )}
        {mode === "confirm" && (
          <>
            <p className="hm-sheet-text">{confirmText}</p>
            <div className="hm-acts">
              <button type="button" className="hm-btn" onClick={() => setMode("menu")}>
                {t("profileCancel")}
              </button>
              <button type="button" className="hm-btn danger" onClick={close}>
                {t("closeTab")}
              </button>
            </div>
          </>
        )}
      </div>
    </AdaptiveSheet>
  );
}

/** The phone's home: start a chat, answer who waits, limits and costs, then the sessions by state. */
export function HomeScreen({ hostName, tabs, onOpen, onAddComputer }: { hostName?: string; tabs: Tab[] | null; onOpen: (ptyId: string) => void; onAddComputer: () => void }) {
  const usage = useRemoteSelector((r) => r.usage);
  const chats = useRemoteSelector((r) => r.chats);
  const canChat = useSupports("chat");
  const sessions = useMemo(() => sessionsOf(tabs ?? [], chats ?? []), [tabs, chats]);
  const shells = useMemo<Session[]>(() => (tabs ?? []).filter((tab) => !tab.cli).map((tab) => ({ key: "t:" + tab.ptyId, kind: "term", cli: "", label: tab.label, cwd: tab.cwd, status: "idle", window: tab.window, tab, contextPct: null })), [tabs]);
  const folders = useMemo(() => [...new Set([...(tabs ?? []).map((tab) => tab.cwd), ...(chats ?? []).map((chat) => chat.cwd)].filter(Boolean))], [tabs, chats]);
  const [newTerminal, setNewTerminal] = useState(false);
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const { now, since } = useStateSince(sessions);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const topSpace = useRef<HTMLDivElement>(null);
  const { onCreate, pending } = useOpenNew(tabs, onOpen);
  const menu = menuKey ? [...sessions, ...shells].find((s) => s.key === menuKey) : undefined;
  // The session left (closed here or on the computer): its sheet goes with it.
  useEffect(() => {
    if (menuKey && !menu) setMenuKey(null);
  }, [menuKey, menu]);

  // The bar stays bare over the aurora until the page slides under it.
  useEffect(() => {
    const page = topSpace.current?.parentElement;
    if (!page) return;
    const onScroll = () => setScrolled(page.scrollTop > 6);
    onScroll();
    page.addEventListener("scroll", onScroll, { passive: true });
    return () => page.removeEventListener("scroll", onScroll);
  }, []);

  const list: [string, string, Session[]][] = [
    [t("homeWorking"), "busy", groups.working],
    [t("homeIdle"), "", groups.idle],
    [t("homeExited"), "", groups.exited],
  ];
  const ago = (s: Session) => Math.max(0, now - since(s.key));

  return (
    <>
      <div className="hm-aurora" aria-hidden="true" />
      <header className={"hm-top" + (scrolled ? " scrolled" : "")}>
        <ComputerSwitcher hostName={hostName} onAdd={onAddComputer} />
      </header>
      <div className="hm-top-space" ref={topSpace} />
      {canChat && <Launcher hostName={hostName} tabs={tabs} onCreate={onCreate} pending={pending} />}
      <PendingRow pending={pending} />
      {groups.waiting.map((s) => (
        <WaitCard key={s.key} s={s} waitedMs={ago(s)} onOpen={onOpen} />
      ))}
      <UsageSection items={usage} />
      {list.map(
        ([title, tone, items]) =>
          items.length > 0 && (
            <section className="hm-group" key={title}>
              <div className="hm-sec">
                <b className={tone}>{title}</b>
                <span>{items.length}</span>
              </div>
              <div className="hm-list">
                {items.map((s) => (
                  <SessionRow key={s.key} s={s} sinceMs={ago(s)} onOpen={onOpen} onMenu={() => setMenuKey(s.key)} />
                ))}
              </div>
            </section>
          ),
      )}
      <section className="hm-group"><div className="hm-sec"><b>{t("terminals")}{shells.length ? ` · ${shells.length}` : ""}</b><button type="button" className="hm-new-terminal" onClick={() => setNewTerminal(true)}><PlusIcon />{t("newTerminalShort")}</button></div>{shells.length ? <div className="hm-list">{shells.map((s) => <div className="hm-row hm-shell" key={s.key}><button type="button" className="hm-row-main" onClick={() => onOpen(s.tab!.ptyId)}><span className="hm-tile st-shell"><TerminalIcon /></span><span className="hm-txt"><b>{s.label}</b><span className="hm-sub mono">{shortCwd(s.cwd)}</span></span></button><button type="button" className="hm-more" aria-label={t("homeSessionActions", { name: s.label })} onClick={() => setMenuKey(s.key)}><DotsIcon /></button></div>)}</div> : <div className="hm-empty">{t("filesNoTerminals")}</div>}</section>
      {newTerminal && <NewTerminalSheet open folders={folders} onClose={() => setNewTerminal(false)} onCreate={onCreate} />}
      {menu && <SessionSheet key={menu.key} s={menu} last={lastInWindow(menu.window, tabs ?? [], chats ?? [])} onOpen={onOpen} onClose={() => setMenuKey(null)} />}
    </>
  );
}
