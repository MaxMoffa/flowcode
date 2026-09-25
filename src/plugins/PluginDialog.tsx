import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { PluginDef, PluginButtonDef } from "./types";
import { useI18n } from "../i18n";
import "./plugin-dialog.css";

interface PluginDialogProps {
  plugin: PluginDef;
  onRunButton: (button: PluginButtonDef) => void;
  onClose: () => void;
}

export function PluginDialog({ plugin, onRunButton, onClose }: PluginDialogProps) {
  const { t } = useI18n();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="plugin-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="plugin-dialog-panel" role="dialog" aria-modal="true">
        <div className="plugin-dialog-title">{plugin.title || plugin.label}</div>
        {plugin.message && (
          <p className={"plugin-dialog-message" + (plugin.id === "__result" ? " is-command-output" : "")}>{plugin.message}</p>
        )}
        <div className="plugin-dialog-actions">
          {(plugin.buttons ?? []).map((button, i) => (
            <button
              key={i}
              type="button"
              className="plugin-dialog-btn"
              onClick={() => {
                onRunButton(button);
                onClose();
              }}
            >
              {button.label}
            </button>
          ))}
          <button type="button" className="plugin-dialog-btn plugin-dialog-btn-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
