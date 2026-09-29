import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useShortcutsConfig } from "./ShortcutsContext";
import { ShortcutKeys } from "./ShortcutKeys";
import { SHORTCUT_GROUP_ORDER, actionsOfGroup } from "./shortcuts";
import "./shortcuts.css";

/** Terminal keys that are built in and can't be rebound. */
const FIXED: { combo: string; label: "shortcuts.fixed.copyInterrupt" | "shortcuts.fixed.paste" | "shortcuts.fixed.newline" }[] = [
  { combo: "Ctrl+C", label: "shortcuts.fixed.copyInterrupt" },
  { combo: "Ctrl+V", label: "shortcuts.fixed.paste" },
  { combo: "Shift+Enter", label: "shortcuts.fixed.newline" },
];

interface ShortcutsDialogProps {
  onClose: () => void;
  onCustomize: () => void;
}

/** The shortcuts guide: every binding as currently configured. */
export function ShortcutsDialog({ onClose, onCustomize }: ShortcutsDialogProps) {
  const { t } = useI18n();
  const { shortcuts } = useShortcutsConfig();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const matches = (label: string, combo: string) =>
    !needle || label.toLowerCase().includes(needle) || combo.toLowerCase().includes(needle);

  const groups = SHORTCUT_GROUP_ORDER.map((group) => ({
    group,
    rows: actionsOfGroup(group)
      .map((action) => ({ action, label: t(`shortcuts.action.${action}`), combo: shortcuts[action] ?? "" }))
      .filter((r) => matches(r.label, r.combo)),
  })).filter((g) => g.rows.length > 0);
  const fixed = FIXED.filter((f) => matches(t(f.label), f.combo));

  return createPortal(
    <div
      className="shortcuts-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shortcuts-panel" role="dialog" aria-modal="true" aria-label={t("shortcuts.title")}>
        <div className="shortcuts-header">
          <div>
            <div className="shortcuts-title">{t("shortcuts.title")}</div>
            <div className="shortcuts-desc">{t("shortcuts.guide.desc")}</div>
          </div>
          <button type="button" className="shortcuts-close" aria-label={t("common.close")} onClick={onClose}>
            <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" width="14" height="14" stroke="currentColor" fill="none">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <input
          ref={inputRef}
          className="shortcuts-search"
          placeholder={t("shortcuts.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="shortcuts-body">
          {groups.length === 0 && fixed.length === 0 && <div className="shortcuts-empty">{t("common.noResults")}</div>}
          {groups.map(({ group, rows }) => (
            <section key={group} className="shortcuts-group">
              <h3 className="shortcuts-group-title">{t(`shortcuts.group.${group}`)}</h3>
              {rows.map((r) => (
                <div key={r.action} className="shortcuts-row">
                  <span className="shortcuts-row-label">{r.label}</span>
                  {r.combo ? <ShortcutKeys combo={r.combo} /> : <span className="shortcut-unassigned">{t("shortcuts.unassigned")}</span>}
                </div>
              ))}
            </section>
          ))}
          {fixed.length > 0 && (
            <section className="shortcuts-group">
              <h3 className="shortcuts-group-title">{t("shortcuts.group.fixed")}</h3>
              {fixed.map((f) => (
                <div key={f.combo} className="shortcuts-row">
                  <span className="shortcuts-row-label">{t(f.label)}</span>
                  <ShortcutKeys combo={f.combo} />
                </div>
              ))}
            </section>
          )}
        </div>
        <div className="shortcuts-footer">
          <button type="button" className="settings-choice" onClick={onCustomize}>
            {t("shortcuts.customize")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
