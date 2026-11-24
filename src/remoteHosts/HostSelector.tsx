import { useEffect, useState } from "react";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { t, useI18n } from "../i18n";
import { connectAllHosts, LOCAL_HOST, setActiveHost, useActiveHost, useHost, useHosts, type HostInfo } from "./remoteHosts";
import { PairHostDialog } from "./PairHostDialog";
import { hostSelectorVisible } from "./hostSelectorVisible";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import "./remote-hosts.css";

export function MonitorIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

export function statusLabel(h: HostInfo): string {
  if (h.status === "online") return t("remoteHosts.status.online");
  if (h.status === "connecting") return t("remoteHosts.status.connecting");
  return t("remoteHosts.status.offline");
}

export function StatusDot({ host }: { host: HostInfo }) {
  return <i className={"host-dot is-" + host.status} title={host.error ?? statusLabel(host)} />;
}

/** A paired PC in the selector's menu. A row of its own (not a snapshot item) so its dot follows the connection while the menu is open. */
function HostMenuRow({ id, hide }: { id: string; hide: () => void }) {
  const host = useHost(id);
  const active = useActiveHost() === id;
  if (!host) return null;
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item"
      title={host.error ?? statusLabel(host)}
      onClick={() => {
        hide();
        setActiveHost(id);
      }}
    >
      <span className="context-menu-icon">
        <StatusDot host={host} />
      </span>
      <span className="context-menu-label">{host.hostName}</span>
      {active && <Check />}
    </button>
  );
}

function Check() {
  return (
    <svg className="context-menu-check" viewBox="0 0 24 24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <polyline points="5 12.5 10 17.5 19 7" />
    </svg>
  );
}

const OPEN_EVENT = "flowcode:open-host-menu";

/** Opens the PC menu from elsewhere (the "more options" menu), under `data-host-menu-anchor` or the header's left edge. */
export function openHostMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function Chevron() {
  return (
    <svg className="host-selector-chev" viewBox="0 0 24 24" width="11" height="11" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor" fill="none" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

interface HostSelectorProps {
  isNarrow: boolean;
  /** Opens Settings on the section listing the connected PCs. */
  onManage: () => void;
}

/** The header's "which PC am I looking at" pill: a monitor with the connection dot on its corner, the PC's name and a chevron. Only the icon and chevron on this PC; tinted blue with the name while another PC is in front. Hidden until a PC is paired, and on this PC also while no paired PC is connected or "always show" is off (the "more options" menu then has "Switch PC…"). */
export function HostSelector({ isNarrow, onManage }: HostSelectorProps) {
  useI18n();
  const { show, hide } = useContextMenu();
  const hosts = useHosts();
  const activeId = useActiveHost();
  const { hostSelectorAlways } = useTerminalSettings();
  const [pairing, setPairing] = useState(false);
  const active = hosts.find((h) => h.id === activeId);
  const name = active ? active.hostName : t("remoteHosts.thisPc");

  function openAt(x: number, y: number) {
    // Live status in the menu: every paired PC starts (or keeps) its connection.
    connectAllHosts();
    const items: ContextMenuItem[] = [
      { label: t("remoteHosts.thisPc"), icon: <MonitorIcon size={14} />, checked: activeId === LOCAL_HOST, onSelect: () => setActiveHost(LOCAL_HOST) },
      ...hosts.map((h) => ({ label: `host:${h.id}`, custom: <HostMenuRow id={h.id} hide={hide} /> })),
      { label: "host-sep", separator: true },
      { label: t("remoteHosts.connectAnother"), onSelect: () => setPairing(true) },
      { label: t("remoteHosts.manage"), onSelect: onManage },
    ];
    show(x, y, items);
  }

  function open(e: React.MouseEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    openAt(rect.left, rect.bottom + 4);
  }

  // Latest openAt for the event listener below (hosts/active change under it).
  const [latest] = useState<{ fn: () => void }>(() => ({ fn: () => {} }));
  latest.fn = () => {
    const anchor = document.querySelector<HTMLElement>("[data-host-menu-anchor]")?.getBoundingClientRect();
    if (anchor) openAt(Math.max(8, anchor.right - 220), anchor.bottom + 4);
    else openAt(8, 44);
  };
  useEffect(() => {
    const on = () => latest.fn();
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [latest]);

  const visible = hostSelectorVisible(hosts, !!active, hostSelectorAlways);
  const title = active ? t("remoteHosts.selector", { name }) : t("remoteHosts.thisPc");

  return (
    <>
      {visible && (
        <button
          type="button"
          className={"host-selector" + (active ? " is-remote" : "")}
          aria-haspopup="menu"
          aria-label={active ? title : t("remoteHosts.computer")}
          title={title}
          onClick={open}
        >
          <span className="host-selector-mon">
            <MonitorIcon />
            {active && <StatusDot host={active} />}
          </span>
          {active && !isNarrow && <span className="host-selector-name">{name}</span>}
          <Chevron />
        </button>
      )}
      {pairing && <PairHostDialog onClose={() => setPairing(false)} />}
    </>
  );
}
