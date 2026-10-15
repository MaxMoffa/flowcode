import { useState } from "react";
import { useBackHandler } from "./back";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, FolderIcon, TerminalIcon } from "./icons";
import { send } from "./remote";

type Cli = "claude" | "codex" | "vibe";
const AGENTS: { id: Cli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "vibe", name: "Mistral Vibe" },
];

/** "Nuovo terminale": where (a folder of the open tabs, or the desktop's start
 * folder) and what to run (a shell, or an agent straight away). The desktop
 * opens it as a new tab; `onCreate` runs once the request is sent. */
export function NewTerminalSheet({ open, folders, onClose, onCreate }: { open: boolean; folders: string[]; onClose: () => void; onCreate: () => void }) {
  /** null = the desktop's start folder. */
  const [cwd, setCwd] = useState<string | null>(null);
  const [cli, setCli] = useState<Cli | null>(null);
  useBackHandler(open, onClose);
  if (!open) return null;

  const create = () => {
    send({ t: "newtab", ...(cwd ? { cwd } : {}), ...(cli ? { cli } : {}) });
    onCreate();
    onClose();
  };

  return (
    <div className="nts-layer">
      <div className="nts-scrim" onClick={onClose} />
      <div className="nts" role="dialog" aria-modal="true" aria-label={t("newTerminal")}>
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
        <button type="button" className="btn primary big" onClick={create}>
          {t("newTermOpen")}
        </button>
      </div>
    </div>
  );
}
