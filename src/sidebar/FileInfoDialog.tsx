import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./file-info-dialog.css";

interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  entry_count: number | null;
  modified: number | null;
  created: number | null;
  permissions_mode: string | null;
  readonly: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

/** "755" -> "rwxr-xr-x", for a friendlier permissions readout next to the raw octal. */
function modeToRwx(mode: string): string {
  const groups = mode.padStart(3, "0").slice(-3).split("");
  return groups
    .map((digit) => {
      const n = Number(digit);
      return (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
    })
    .join("");
}

interface FileInfoDialogProps {
  path: string;
  name: string;
  isDir: boolean;
  onClose: () => void;
}

export function FileInfoDialog({ path, name, isDir, onClose }: FileInfoDialogProps) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<FileInfo>("get_file_info", { path })
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [path]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="file-info-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="file-info-panel" role="dialog" aria-modal="true">
        <div className="file-info-header">
          <span>Informazioni</span>
          <button type="button" className="file-info-close" aria-label="Chiudi" onClick={onClose}>
            <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" width="14" height="14" stroke="currentColor" fill="none">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="file-info-name" title={name}>
          {name}
        </div>
        {error ? (
          <div className="file-info-error">Impossibile leggere le informazioni: {error}</div>
        ) : !info ? (
          <div className="file-info-loading">Caricamento…</div>
        ) : (
          <div className="file-info-rows">
            <div className="file-info-row">
              <span className="file-info-label">Percorso</span>
              <span className="file-info-value file-info-value-mono">{info.path}</span>
            </div>
            <div className="file-info-row">
              <span className="file-info-label">Tipo</span>
              <span className="file-info-value">{isDir ? "Cartella" : "File"}</span>
            </div>
            {isDir ? (
              <div className="file-info-row">
                <span className="file-info-label">Elementi</span>
                <span className="file-info-value">{info.entry_count ?? "—"}</span>
              </div>
            ) : (
              <div className="file-info-row">
                <span className="file-info-label">Dimensione</span>
                <span className="file-info-value">{formatSize(info.size)}</span>
              </div>
            )}
            <div className="file-info-row">
              <span className="file-info-label">Modificato</span>
              <span className="file-info-value">{formatDate(info.modified)}</span>
            </div>
            <div className="file-info-row">
              <span className="file-info-label">Creato</span>
              <span className="file-info-value">{formatDate(info.created)}</span>
            </div>
            <div className="file-info-row">
              <span className="file-info-label">Permessi</span>
              <span className="file-info-value file-info-value-mono">
                {info.permissions_mode ? `${info.permissions_mode} (${modeToRwx(info.permissions_mode)})` : "—"}
              </span>
            </div>
            <div className="file-info-row">
              <span className="file-info-label">Sola lettura</span>
              <span className="file-info-value">{info.readonly ? "Sì" : "No"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
