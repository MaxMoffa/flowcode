import { useState } from "react";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { t, useI18n } from "../i18n";
import { connectAllHosts, LOCAL_HOST, setActiveHost, useActiveHost, useHost, useHosts, type HostInfo } from "./remoteHosts";
import { PairHostDialog } from "./PairHostDialog";
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

interface HostSelectorProps {
  isNarrow: boolean;
  /** Opens Settings on the section listing the connected PCs. */
  onManage: () => void;
}

/** The header's "which PC am I looking at" button: this PC, or any paired one. An icon alone while this PC is in front; with another PC in front, a chip beside it names that PC. Nothing at all until a PC is paired (pairing is then in the "more options" menu). */
export function HostSelector({ isNarrow, onManage }: HostSelectorProps) {
  useI18n();
  const { show, hide } = useContextMenu();
  const hosts = useHosts();
  const activeId = useActiveHost();
  const [pairing, setPairing] = useState(false);
  const active = hosts.find((h) => h.id === activeId);
  const name = active ? active.hostName : t("remoteHosts.thisPc");

  function open(e: React.MouseEvent<HTMLElement>) {
    // Live status in the menu: every paired PC starts (or keeps) its connection.
    connectAllHosts();
    const rect = (e.currentTarget.closest(".host-selector") ?? e.currentTarget).getBoundingClientRect();
    const items: ContextMenuItem[] = [
      { label: t("remoteHosts.thisPc"), icon: <MonitorIcon size={14} />, checked: activeId === LOCAL_HOST, onSelect: () => setActiveHost(LOCAL_HOST) },
      ...hosts.map((h) => ({ label: `host:${h.id}`, custom: <HostMenuRow id={h.id} hide={hide} /> })),
      { label: "host-sep", separator: true },
      { label: t("remoteHosts.connectAnother"), onSelect: () => setPairing(true) },
      { label: t("remoteHosts.manage"), onSelect: onManage },
    ];
    show(rect.left, rect.bottom + 4, items);
  }

  if (hosts.length === 0 && !pairing) return null;
  const title = active ? t("remoteHosts.selector", { name }) : t("remoteHosts.thisPc");

  return (
    <>
      <div className={"host-selector" + (active ? " is-remote" : "")}>
        <button type="button" className={"icon-button" + (active ? " is-active" : "")} aria-haspopup="menu" aria-label={t("remoteHosts.computer")} title={title} onClick={open}>
          <MonitorIcon />
        </button>
        {active && (
          // The same menu as the icon (which is the keyboard's way in): a click on the name is the obvious place too.
          <button type="button" className="host-selector-chip" tabIndex={-1} aria-haspopup="menu" aria-label={title} title={title} onClick={open}>
            <StatusDot host={active} />
            {!isNarrow && <span className="host-selector-name">{name}</span>}
          </button>
        )}
      </div>
      {pairing && <PairHostDialog onClose={() => setPairing(false)} />}
    </>
  );
}
