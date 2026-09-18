import { useRef, useState, type ChangeEvent } from "react";
import type { PluginDef, PluginManifest } from "../plugins/types";
import { PLUGIN_ACTION_LABELS } from "../plugins/types";
import { pluginIconNode } from "../plugins/icons";
import { PluginCreateDialog } from "./PluginCreateDialog";
import "./funzionalita-page.css";

/** Loose validation on purpose: the plugin standard is safe by construction
 * (a bad/unknown `action` is simply a no-op in runPlugin), so this only
 * needs to catch "not a plugin manifest at all", not police every field. */
function isPluginManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.trim() !== "" && typeof v.label === "string" && v.label.trim() !== "" && typeof v.action === "string" && v.action in PLUGIN_ACTION_LABELS;
}

interface FunzionalitaPageProps {
  plugins: PluginDef[];
  enabledIds: string[];
  onToggleEnabled: (id: string) => void;
  onAdd: (manifest: PluginManifest) => void;
  onDelete: (id: string) => void;
}

export function FunzionalitaPage({ plugins, enabledIds, onToggleEnabled, onAdd, onDelete }: FunzionalitaPageProps) {
  const [creating, setCreating] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const existingIds = plugins.map((p) => p.id);

  function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    file
      .text()
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (!isPluginManifest(parsed)) {
          setImportError(`"${file.name}" non è un manifest di plugin valido (mancano id/label/action).`);
          return;
        }
        if (existingIds.includes(parsed.id) && !window.confirm(`Esiste già un plugin con id "${parsed.id}". Sovrascriverlo?`)) {
          return;
        }
        onAdd(parsed);
      })
      .catch((err) => setImportError(`Impossibile leggere "${file.name}": ${err}`));
  }

  return (
    <div>
      <p className="funzionalita-intro">
        Ogni funzionalità è un piccolo plugin: quelle di base servono al programma e non si possono eliminare, ma tutte si
        possono attivare o disattivare nella barra rapida. Lo standard completo per crearne di nuovi (comandi, popup,
        dialog con più pulsanti, azioni con output dinamico) è documentato in <code>PLUGINS.md</code> nel repository - da
        lì si può anche scrivere a mano un plugin più avanzato di quelli creabili qui, e installarlo con "Importa da
        file".
      </p>

      <table className="funzionalita-table">
        <thead>
          <tr>
            <th aria-label="Icona" />
            <th>Nome</th>
            <th>Nella barra</th>
            <th aria-label="Azioni" />
          </tr>
        </thead>
        <tbody>
          {plugins.map((plugin) => (
            <tr key={plugin.id}>
              <td className="funzionalita-icon-cell">{pluginIconNode(plugin)}</td>
              <td>
                <div className="funzionalita-name">
                  {plugin.label}
                  {plugin.builtin && <span className="funzionalita-badge">di base</span>}
                </div>
                {plugin.description && <div className="funzionalita-desc">{plugin.description}</div>}
              </td>
              <td>
                <label className="funzionalita-switch">
                  <input
                    type="checkbox"
                    checked={enabledIds.includes(plugin.id)}
                    onChange={() => onToggleEnabled(plugin.id)}
                  />
                  <span className="funzionalita-switch-track" />
                </label>
              </td>
              <td className="funzionalita-actions-cell">
                {!plugin.builtin && (
                  <button
                    type="button"
                    className="funzionalita-delete"
                    aria-label={`Elimina ${plugin.label}`}
                    title="Elimina"
                    onClick={() => onDelete(plugin.id)}
                  >
                    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" stroke="currentColor" fill="none">
                      <path d="M5 7.5h14" />
                      <path d="M9.5 7.5V5.6c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.9" />
                      <path d="M7 7.5 7.7 19a1.3 1.3 0 0 0 1.3 1.3h6a1.3 1.3 0 0 0 1.3-1.3l.7-11.5" />
                    </svg>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="funzionalita-toolbar">
        <button type="button" className="settings-choice" onClick={() => setCreating(true)}>
          + Nuovo plugin
        </button>
        <button type="button" className="settings-choice" onClick={() => fileInputRef.current?.click()}>
          Importa da file
        </button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
      </div>
      {importError && <p className="funzionalita-import-error">{importError}</p>}

      {creating && (
        <PluginCreateDialog
          existingIds={existingIds}
          onCreate={(manifest) => {
            onAdd(manifest);
            setCreating(false);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
