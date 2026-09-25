import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginAction, PluginManifest } from "../plugins/types";
import { PLUGIN_ACTION_LABELS } from "../plugins/types";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
        <div className="plugin-create-title">{t("features.new")}</div>

        <label className="funzionalita-field">
          {t("features.col.name")}
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("pluginCreate.name.placeholder")} />
        </label>
        <label className="funzionalita-field">
          {t("pluginCreate.description")}
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("pluginCreate.description.placeholder")} />
        </label>
        <label className="funzionalita-field">
          {t("pluginCreate.action")}
          <select value={action} onChange={(e) => setAction(e.target.value as PluginAction)}>
            {QUICK_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(PLUGIN_ACTION_LABELS[a])}
              </option>
            ))}
          </select>
        </label>
        {action === "runCommand" && (
          <label className="funzionalita-field">
            {t("pluginCreate.command")}
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("pluginCreate.command.placeholder")}
              className="funzionalita-field-mono"
            />
          </label>
        )}
        {action === "notify" && (
          <label className="funzionalita-field">
            {t("pluginCreate.message")}
            <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("pluginCreate.message.placeholder")} />
          </label>
        )}

        <p className="plugin-create-hint">
          {t("pluginCreate.hint").split("{file}")[0]}
          <code>PLUGINS.md</code>
          {t("pluginCreate.hint").split("{file}")[1]}
        </p>

        <div className="plugin-create-actions">
          <button type="button" className="settings-choice" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="settings-choice is-active" onClick={submit}>
            {t("pluginCreate.create")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
