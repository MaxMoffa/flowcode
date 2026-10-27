import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useOutsideClose } from "../hooks/useOutsideClose";
import { readString, removeKey, writeString } from "../lib/storage";
import type { AgentCli } from "../agents/cliInfo";
import { CLI_INFO } from "../agents/cliInfo";
import type { ChatSession } from "./useChat";

type ModeKind = "ask" | "edit" | "plan" | "readonly" | "auto" | "bypass" | "code" | "chat" | "generic";

const KIND_BY_ID: Record<string, ModeKind> = {
  default: "ask",
  ask: "ask",
  manual: "ask",
  acceptedits: "edit",
  "accept-edits": "edit",
  plan: "plan",
  architect: "plan",
  bypasspermissions: "bypass",
  "full-access": "bypass",
  fullaccess: "bypass",
  yolo: "bypass",
  "read-only": "readonly",
  readonly: "readonly",
  auto: "auto",
  code: "code",
  chat: "chat",
};

/** Which icon a mode gets: its id first, then keywords in its name. */
function kindOf(id: string, name: string): ModeKind {
  const byId = KIND_BY_ID[id.toLowerCase()];
  if (byId) return byId;
  const n = `${id} ${name}`.toLowerCase();
  if (/bypass|yolo|full.?access|dangerous/.test(n)) return "bypass";
  if (/plan|architect/.test(n)) return "plan";
  if (/accept|edit/.test(n)) return "edit";
  if (/read.?only/.test(n)) return "readonly";
  if (/auto/.test(n)) return "auto";
  if (/ask|manual|default|confirm/.test(n)) return "ask";
  if (/code/.test(n)) return "code";
  if (/chat/.test(n)) return "chat";
  return "generic";
}

const PATHS: Record<ModeKind, ReactNode> = {
  // hand: asks before acting
  ask: <path d="M8 13V5.5a1.5 1.5 0 013 0V12M11 11V4a1.5 1.5 0 013 0v8M14 11V6a1.5 1.5 0 013 0v8c0 4-2.5 6-5.5 6S7 18.5 5.5 15.5L4 12.5a1.4 1.4 0 012.4-1.4L8 13" />,
  // pencil with a check
  edit: (
    <>
      <path d="M4 20l1-4L15.5 5.5a2.1 2.1 0 013 3L8 19z" />
      <path d="M14 7l3 3" />
      <path d="M14 20l2 2 5-5" />
    </>
  ),
  // map
  plan: (
    <>
      <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  readonly: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // wand
  auto: (
    <>
      <path d="M4 20L15 9" />
      <path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z" />
    </>
  ),
  bypass: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  code: (
    <>
      <path d="M8 7l-5 5 5 5" />
      <path d="M16 7l5 5-5 5" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  generic: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4l3 2" />
    </>
  ),
};

function ModeIcon({ kind, size }: { kind: ModeKind; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}

const defaultKey = (agent: AgentCli) => `flowcode.chatDefaultMode.${agent}`;

/** The composer's mode pill and the menu it opens upward. Also applies the
 * agent's default mode (if set) once to a brand-new session. */
export default function ChatModeSelect({ chat, agent }: { chat: ChatSession; agent: AgentCli }) {
  const { t } = useI18n();
  const modes = chat.modes;
  const currentModeId = chat.model.currentModeId ?? modes?.currentModeId ?? null;
  const [open, setOpen] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(() => readString(defaultKey(agent)));
  const anchorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClose(open, [anchorRef], () => setOpen(false), { escape: true });

  // Apply the stored default once per new session, before the user picks one.
  const appliedRef = useRef<string | null>(null);
  const { chatId, resumed, phase } = chat;
  const hasModes = !!modes;
  useEffect(() => {
    if (!chatId || !hasModes || resumed || phase !== "ready" || appliedRef.current === chatId) return;
    appliedRef.current = chatId;
    const stored = readString(defaultKey(agent));
    if (stored && stored !== chat.modes?.currentModeId && chat.modes?.availableModes.some((m) => m.id === stored)) chat.setMode(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, hasModes, resumed, phase, agent]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const current = Array.from(items).find((el) => el.getAttribute("aria-checked") === "true");
    (current ?? items[0]).focus();
  }, [open]);

  if (!modes || modes.availableModes.length === 0) return null;
  const currentMode = modes.availableModes.find((m) => m.id === currentModeId);
  const pillKind = currentMode ? kindOf(currentMode.id, currentMode.name) : "generic";
  const agentLabel = CLI_INFO[agent]?.label ?? agent;

  const close = () => {
    setOpen(false);
    pillRef.current?.focus();
  };

  const toggleDefault = (id: string) => {
    if (defaultId === id) {
      removeKey(defaultKey(agent));
      setDefaultId(null);
    } else {
      writeString(defaultKey(agent), id);
      setDefaultId(id);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if ((e.key === "d" || e.key === "D") && index >= 0) {
      e.preventDefault();
      const id = items[index].dataset.modeId;
      if (id) toggleDefault(id);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="chat-mode-anchor" ref={anchorRef}>
      <button
        ref={pillRef}
        type="button"
        className={`chat-mode-pill is-${pillKind}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chat.menu.mode")}
        onClick={() => setOpen((o) => !o)}
      >
        <ModeIcon kind={pillKind} size={15} />
        <span className="chat-mode-name">{currentMode?.name ?? t("chat.menu.mode")}</span>
      </button>
      {open && (
        <div className="chat-menu chat-mode-menu" role="menu" aria-label={t("chat.mode.caption")} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="chat-mode-caption">{t("chat.mode.caption")}</div>
          {modes.availableModes.map((mode) => {
            const kind = kindOf(mode.id, mode.name);
            const selected = mode.id === currentModeId;
            const isDefault = mode.id === defaultId;
            const starLabel = isDefault ? t("chat.mode.clearDefault", { agent: agentLabel }) : t("chat.mode.setDefault", { agent: agentLabel });
            return (
              <div key={mode.id} className={`chat-mode-row is-${kind}${selected ? " is-selected" : ""}${isDefault ? " is-default" : ""}`}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-mode-id={mode.id}
                  className="chat-mode-item"
                  onClick={() => {
                    setOpen(false);
                    pillRef.current?.focus();
                    chat.setMode(mode.id);
                  }}
                >
                  <span className="chat-mode-icon">
                    <ModeIcon kind={kind} size={16} />
                  </span>
                  <span className="chat-mode-text">
                    <span className="chat-mode-title">{mode.name}</span>
                    {mode.description && <span className="chat-mode-desc">{mode.description}</span>}
                  </span>
                </button>
                <button type="button" tabIndex={-1} className="chat-mode-star" title={starLabel} aria-label={starLabel} aria-pressed={isDefault} onClick={() => toggleDefault(mode.id)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill={isDefault ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
