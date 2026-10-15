import { useRef, useState } from "react";
import { useBackHandler } from "./back";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, FolderIcon, TerminalIcon } from "./icons";
import { send, useRemoteSelector } from "./remote";
import { useSheetDrag } from "./useSheetDrag";

type Cli = "claude" | "codex" | "vibe";
const AGENTS: { id: Cli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "vibe", name: "Mistral Vibe" },
];

/** "Nuovo terminale": where (a folder of the open tabs, or the desktop's start
 * folder), what to run (a shell, or an agent straight away) and under which
 * account profile. The desktop opens it as a new tab; `onCreate` runs once the
 * request is sent. */
export function NewTerminalSheet({ open, folders, onClose, onCreate }: { open: boolean; folders: string[]; onClose: () => void; onCreate: () => void }) {
  /** null = the desktop's start folder. */
  const [cwd, setCwd] = useState<string | null>(null);
  const [cli, setCli] = useState<Cli | null>(null);
  /** null = automatic (the folder's project default), "" = the default profile. */
  const [profile, setProfile] = useState<string | null>(null);
  const profiles = useRemoteSelector((r) => r.profiles);
  useBackHandler(open, onClose);
  const sheet = useRef<HTMLDivElement>(null);
  useSheetDrag(sheet, onClose, open);
  if (!open) return null;

  const create = () => {
    send({ t: "newtab", ...(cwd ? { cwd } : {}), ...(cli ? { cli } : {}), ...(profile !== null ? { profile } : {}) });
    onCreate();
    onClose();
  };

  return (
    <div className="nts-layer">
      <div className="nts-scrim" onClick={onClose} />
      <div ref={sheet} className="nts" role="dialog" aria-modal="true" aria-label={t("newTerminal")}>
        <div className="nts-grab" aria-hidden="true" />
        <h2>{t("newTerminal")}</h2>
        <div className="nts-field">
          <span className="nts-label">{t("newTermFolder")}</span>
          <div className="nts-folders">
            <button type="button" className={"nts-folder" + (cwd === null ? " on" : "")} onClick={() => setCwd(null)}>
              <FolderIcon />
              <span>{t("newTermStartFolder")}</span>
            </button>
            {folders.map((f) => (
              <button key={f} type="button" className={"nts-folder" + (cwd === f ? " on" : "")} onClick={() => setCwd(f)}>
                <FolderIcon />
                <span className="mono">{shortCwd(f)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="nts-field">
          <span className="nts-label">{t("newTermRun")}</span>
          <div className="nts-choices">
            <button type="button" className={"nts-choice" + (cli === null ? " on" : "")} onClick={() => setCli(null)}>
              <TerminalIcon />
              {t("newTermShell")}
            </button>
            {AGENTS.map((a) => (
              <button key={a.id} type="button" className={"nts-choice" + (cli === a.id ? " on" : "")} onClick={() => setCli(a.id)}>
                <AgentLogo cli={a.id} size={18} />
                {a.name}
              </button>
            ))}
          </div>
        </div>
        {profiles && profiles.length > 0 && (
          <div className="nts-field">
            <span className="nts-label">{t("newTermProfile")}</span>
            <div className="nts-choices">
              <button type="button" className={"nts-choice" + (profile === null ? " on" : "")} onClick={() => setProfile(null)}>
                <i className="dot" />
                {t("newTermProfileAuto")}
              </button>
              <button type="button" className={"nts-choice" + (profile === "" ? " on" : "")} onClick={() => setProfile("")}>
                <i className="dot" style={{ background: "var(--muted)" }} />
                {t("defaultProfile")}
              </button>
              {profiles.map((p) => (
                <button key={p.id} type="button" className={"nts-choice" + (profile === p.id ? " on" : "")} onClick={() => setProfile(p.id)}>
                  <i className="dot" style={{ background: p.color }} />
                  <span className="nts-profile-name">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <button type="button" className="btn primary big" onClick={create}>
          {t("newTermOpen")}
        </button>
      </div>
    </div>
  );
}
