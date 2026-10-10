import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useProfiles } from "./profiles";
import "../dialog/modal.css";
import "./profile-picker.css";

interface ProfilePickerProps {
  /** `null` = the default profile. */
  onPick: (profileId: string | null) => void;
  onClose: () => void;
}

/** The keyboard quick picker behind "New tab with profile": the default
 * profile and every account profile, pickable with the arrows + Enter or by
 * their number. */
export function ProfilePicker({ onPick, onClose }: ProfilePickerProps) {
  const { t } = useI18n();
  const { profiles } = useProfiles();
  const [index, setIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const rows = [{ id: null as string | null, name: t("agents.profile.default"), color: null as string | null }, ...profiles];

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Capture phase, like the app's own shortcuts: the terminal underneath
  // would otherwise swallow the keys. Everything is stopped here, so nothing
  // typed while the picker is open reaches the shell.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown") setIndex((i) => (i + 1) % rows.length);
      else if (e.key === "ArrowUp") setIndex((i) => (i - 1 + rows.length) % rows.length);
      else if (e.key === "Enter") onPick(rows[index]?.id ?? null);
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= rows.length) onPick(rows[Number(e.key) - 1].id);
      else if (e.key === "Tab") handled = true; // focus stays on the panel
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-panel profile-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t("profiles.picker.title")}
      >
        <div className="profile-picker-title">{t("profiles.picker.title")}</div>
        <div role="listbox" aria-label={t("agents.profile.label")}>
          {rows.map((row, i) => (
            <button
              key={row.id ?? "default"}
              type="button"
              role="option"
              aria-selected={i === index}
              tabIndex={-1}
              className={"profile-picker-row" + (i === index ? " is-selected" : "")}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(row.id)}
            >
              <span
                className={"profile-picker-dot" + (row.color ? "" : " is-default")}
                style={row.color ? { background: row.color } : undefined}
              />
              <span className="profile-picker-name">{row.name}</span>
              {i < 9 && <kbd className="profile-picker-key">{i + 1}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
