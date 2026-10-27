import { useEffect, useRef, useState } from "react";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { t, useI18n } from "../i18n";
import { AGENT_CLIS, CLI_INFO } from "../agents/cliInfo";
import { ChatIcon } from "../app/icons";
import { agentCliIcon } from "../plugins/icons";
import { BusySweep } from "../terminal/TabStrip";
import { closeRemoteEntry, connectHost, expectNewTab, remoteEntries, selectRemoteKey, sendToHost, useHost, useHostState, type RemoteEntry } from "./remoteHosts";
import { statusLabel } from "./HostSelector";
import "../terminal/tabstrip.css";
import "./remote-hosts.css";

type Attention = "waiting" | "busy" | "idle";

function attentionOf(entry: RemoteEntry): Attention {
  const status = entry.kind === "pty" ? entry.tab.status : entry.chat.status;
  return status === "waiting" ? "waiting" : status === "busy" ? "busy" : "idle";
}

function entryLabel(entry: RemoteEntry) {
  return entry.kind === "pty" ? entry.tab.label : entry.chat.label;
}

function entryIcon(entry: RemoteEntry, attention: Attention) {
  if (entry.kind === "chat") {
    return (
      <span className="term-tab-agent">
        <span className={"term-tab-agent-logo is-" + attention}>
          <ChatIcon size={13} strokeWidth={1.8} />
        </span>
      </span>
    );
  }
  if (entry.tab.cli) {
    return (
      <span className="term-tab-agent">
        <span className={"term-tab-agent-logo is-" + attention}>{agentCliIcon(entry.tab.cli)}</span>
      </span>
    );
  }
  return <span className="term-tab-dot" />;
}

/** The tabs of another PC (its terminals and chats), in place of the local strip. */
export function RemoteTabStrip({ hostId }: { hostId: string }) {
  useI18n();
  const { show } = useContextMenu();
  const host = useHost(hostId);
  const { tabs, chats, activeKey } = useHostState(hostId);
  const entries = remoteEntries(tabs, chats);
  const caps = host?.caps ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // A vertical wheel scrolls the row sideways, like the local strip.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the tab in front in view (by hand, on the row alone).
  useEffect(() => {
    const el = viewportRef.current;
    const tabEl = el?.querySelector<HTMLElement>(".term-tab.is-active");
    if (!el || !tabEl) return;
    if (tabEl.offsetLeft < el.scrollLeft) el.scrollTo({ left: tabEl.offsetLeft });
    else if (tabEl.offsetLeft + tabEl.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollTo({ left: tabEl.offsetLeft + tabEl.offsetWidth - el.clientWidth });
  }, [activeKey, entries.length]);

  function startEditing(entry: RemoteEntry) {
    const can = entry.kind === "pty" ? caps.includes("rename") : caps.includes("chatRename");
    if (!can) return;
    setEditing(entry.key);
    setDraft(entryLabel(entry));
  }

  function commit(entry: RemoteEntry) {
    const label = draft.trim();
    setEditing(null);
    if (!label || label === entryLabel(entry)) return;
    if (entry.kind === "pty") void sendToHost(hostId, { t: "rename", ptyId: entry.tab.ptyId, label });
    else void sendToHost(hostId, { t: "chatrename", chatId: entry.chat.chatId, label });
  }

  function openNewMenu(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: t("menu.newTerminal"),
        onSelect: () => {
          expectNewTab(hostId);
          void sendToHost(hostId, { t: "newtab" });
        },
      },
    ];
    if (caps.includes("chat")) {
      items.push({ label: "remote-new-sep", separator: true });
      for (const cli of AGENT_CLIS) {
        items.push({
          label: t("remoteHosts.newChatWith", { agent: CLI_INFO[cli].label }),
          icon: agentCliIcon(cli),
          onSelect: () => {
            expectNewTab(hostId);
            void sendToHost(hostId, { t: "newchat", cli });
          },
        });
      }
    }
    show(rect.left, rect.bottom + 4, items);
  }

  const online = host?.status === "online";

  return (
    <div className="tab-strip remote-tab-strip" data-tauri-drag-region>
      <div className="tab-strip-scroller">
        <div className="tab-strip-viewport" ref={viewportRef} data-tauri-drag-region>
          {entries.map((entry) => {
            const attention = attentionOf(entry);
            const label = entryLabel(entry);
            const cwd = entry.kind === "pty" ? entry.tab.cwd : entry.chat.cwd;
            const win = entry.kind === "pty" ? entry.tab.window : entry.chat.window;
            const closable = entry.kind === "pty" ? caps.includes("closeTab") : caps.includes("chatCloseTab");
            return (
              <div
                key={entry.key}
                className={"term-tab" + (entry.key === activeKey ? " is-active" : "") + " attn-" + attention}
                title={`${label}\n${win} · ${cwd}`}
                onClick={() => selectRemoteKey(hostId, entry.key)}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest(".term-tab-close, input")) return;
                  startEditing(entry);
                }}
              >
                {attention === "busy" && <BusySweep />}
                {entryIcon(entry, attention)}
                {editing === entry.key ? (
                  <input
                    ref={inputRef}
                    className="term-tab-rename-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commit(entry)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit(entry);
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="term-tab-label">{label}</span>
                )}
                {closable && (
                  <button
                    type="button"
                    className="term-tab-close"
                    aria-label={t("tabs.closeNamed", { name: label })}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeRemoteEntry(hostId, entry);
                    }}
                  >
                    <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <button type="button" className="term-tab-new" aria-label={t("remoteHosts.newTab")} title={t("remoteHosts.newTab")} disabled={!online} onClick={openNewMenu}>
        <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {host && !online && (
        <span className={"host-chip is-" + host.status} title={host.error ?? statusLabel(host)}>
          {host.status === "connecting" ? (host.error ? t("remoteHosts.status.retrying", { error: host.error }) : t("remoteHosts.status.connectingDots")) : host.error ? t("remoteHosts.status.refused", { error: host.error }) : t("remoteHosts.status.offlineDash")}
          {/* Retrying also ends the wait between two attempts early. */}
          {(host.status === "offline" || host.error) && (
            <button type="button" className="host-chip-retry" onClick={() => void connectHost(hostId)}>
              {t("remoteHosts.retry")}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
