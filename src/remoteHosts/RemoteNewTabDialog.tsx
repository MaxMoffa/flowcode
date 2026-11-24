import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_CLIS, CLI_INFO } from "../agents/cliInfo";
import { useI18n } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import { hostRequest } from "./hostRequest";
import { joinRemote } from "./remoteFiles";
import { chatLike, expectNewTab, sendToHost, terminalLike, useHost } from "./remoteHosts";
import type { LsEntry } from "../../shared/remote-types";
import "../dialog/modal.css";
import "./remote-files.css";

interface Listing {
  path: string;
  parent: string | null;
  folders: LsEntry[];
}

/** A new terminal or chat on another PC, in a folder picked from that PC's disk (the quick menu starts in its default folder). */
export function RemoteNewTabDialog({ hostId, startAt, onClose }: { hostId: string; startAt: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const canChat = !!host?.caps.includes("chat");
  const [path, setPath] = useState<string | null>(startAt);
  const [typed, setTyped] = useState(startAt ?? "");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // No folder yet: begin at the PC's roots, else at what the path says.
  useEffect(() => {
    const id = ++seq.current;
    setError(null);
    hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: path ? { op: "list", path } : { op: "roots" } }), 15_000)
      .then((m) => {
        if (id !== seq.current || !m.response) return;
        if (m.response.kind === "roots") {
          setListing({ path: "", parent: null, folders: m.response.roots.map((r) => ({ name: r.path, dir: true })) });
        } else if (m.response.kind === "list") {
          setListing({ path: m.response.path, parent: m.response.parent, folders: m.response.entries.filter((e) => e.dir && !e.hidden && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name)) });
          setTyped(m.response.path);
        }
      })
      .catch((e: Error) => id === seq.current && setError(e.message));
  }, [hostId, path]);

  const here = listing?.path || null;
  const start = (kind: "terminal" | string) => {
    if (!here) return;
    expectNewTab(hostId, kind === "terminal" ? terminalLike(here) : chatLike(kind, here));
    void sendToHost(hostId, kind === "terminal" ? { t: "newtab", cwd: here } : { t: "newchat", cli: kind, cwd: here });
    onClose();
  };
  const open = (name: string) => setPath(listing?.path ? joinRemote(listing.path, name) : name);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel remote-newtab" role="dialog" aria-modal="true" aria-label={t("remoteHosts.newTab")}>
        <div className="remote-file-head">
          <div className="remote-file-name">
            <b>{t("remoteHosts.newIn", { host: host?.hostName ?? "" })}</b>
          </div>
          <button type="button" className="settings-choice" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
        <form
          className="remote-newtab-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) setPath(typed.trim());
          }}
        >
          <button type="button" className="settings-choice" disabled={!listing?.parent && !listing?.path} onClick={() => setPath(listing?.parent ?? null)} aria-label={t("files.up")} title={t("files.up")}>
            ↑
          </button>
          <input className="settings-text-input" value={typed} spellCheck={false} onChange={(e) => setTyped(e.target.value)} aria-label={t("remoteHosts.newFolder")} />
        </form>
        <div className="remote-newtab-list">
          {error && <div className="remote-file-note">{error === "offline" ? t("remoteHosts.file.offline") : error}</div>}
          {!error && !listing && <div className="remote-file-note">{t("common.loading")}</div>}
          {listing?.folders.map((f) => (
            <button key={f.name} type="button" className="remote-newtab-row" onClick={() => open(f.name)}>
              {f.name}
            </button>
          ))}
          {listing && listing.folders.length === 0 && !error && <div className="remote-file-note">{t("files.empty")}</div>}
        </div>
        <div className="remote-newtab-actions">
          <button type="button" className="settings-choice is-primary" disabled={!here} onClick={() => start("terminal")}>
            {t("menu.newTerminal")}
          </button>
          {canChat &&
            AGENT_CLIS.map((cli) => (
              <button key={cli} type="button" className="settings-choice" disabled={!here} onClick={() => start(cli)} title={t("remoteHosts.newChatWith", { agent: CLI_INFO[cli].label })}>
                <span className="remote-newtab-logo">{agentCliIcon(cli)}</span>
                {CLI_INFO[cli].label}
              </button>
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
