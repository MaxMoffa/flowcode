import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginAction, PluginManifest } from "../plugins/types";
import { PLUGIN_ACTION_LABELS } from "../plugins/types";
import "./plugin-create-dialog.css";

/** The quick, in-app path for the common cases (run a command, show a
 * message). Anything richer - a dialog with several buttons, for instance -
 * is written by hand as a JSON file per the standard in PLUGINS.md; this
 * form deliberately doesn't try to cover that. */
const QUICK_ACTIONS: PluginAction[] = ["runCommand", "notify", "newTerminal", "clearTerminal", "toggleSidebar"];

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "plugin"
  );
}

interface PluginCreateDialogProps {
  existingIds: string[];
  onCreate: (manifest: PluginManifest) => void;
  onClose: () => void;
}

export function PluginCreateDialog({ existingIds, onCreate, onClose }: PluginCreateDialogProps) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [action, setAction] = useState<PluginAction>("runCommand");
  const [command, setCommand] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function submit() {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    if (action === "runCommand" && !command.trim()) return;
    if (action === "notify" && !message.trim()) return;
    let id = slugify(trimmedLabel);
    let n = 2;
    while (existingIds.includes(id)) {
      id = `${slugify(trimmedLabel)}-${n++}`;
    }
    onCreate({
      id,
      label: trimmedLabel,
      description: description.trim(),
      action,
      command: action === "runCommand" ? command.trim() : undefined,
      message: action === "notify" ? message.trim() : undefined,
    });
  }

  return createPortal(
    <div
      className="plugin-create-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="plugin-create-panel" role="dialog" aria-modal="true">
        <div className="plugin-create-title">Nuovo plugin</div>

        <label className="funzionalita-field">
          Nome
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Es. Avvia i test" />
        </label>
        <label className="funzionalita-field">
          Descrizione (opzionale)
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Cosa fa" />
        </label>
        <label className="funzionalita-field">
          Azione
          <select value={action} onChange={(e) => setAction(e.target.value as PluginAction)}>
            {QUICK_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {PLUGIN_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        {action === "runCommand" && (
          <label className="funzionalita-field">
            Comando
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Es. npm test"
              className="funzionalita-field-mono"
            />
          </label>
        )}
        {action === "notify" && (
          <label className="funzionalita-field">
            Messaggio
            <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Testo del popup" />
          </label>
        )}

        <p className="plugin-create-hint">
          Serve un dialog con più pulsanti o altro di più complesso? Vedi <code>PLUGINS.md</code> nel repository.
        </p>

        <div className="plugin-create-actions">
          <button type="button" className="settings-choice" onClick={onClose}>
            Annulla
          </button>
          <button type="button" className="settings-choice is-active" onClick={submit}>
            Crea plugin
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
