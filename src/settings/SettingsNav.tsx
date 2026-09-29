import { useMemo, useState } from "react";
import { useSettingsSection } from "./SettingsSectionContext";
import { SECTIONS, SECTION_SHORT_KEYS, SECTION_TITLE_KEYS, SETTINGS_INDEX, type SettingEntry } from "./settingsIndex";
import { useI18n } from "../i18n";
import "./settings-nav.css";

/** Lowercase and accent-free, so "funzionalita" finds "Funzionalità". */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function SettingsNav() {
  const { t, language } = useI18n();
  const { section, setSection, goToSetting } = useSettingsSection();
  const [query, setQuery] = useState("");

  const terms = normalize(query).split(/\s+/).filter(Boolean);

  // Rebuilt when the language changes: matching runs on the translated text the user actually sees.
  const results = useMemo(() => {
    if (terms.length === 0) return [];
    const scored: { entry: SettingEntry; score: number }[] = [];
    for (const entry of SETTINGS_INDEX) {
      const label = normalize(t(entry.label));
      const rest = normalize(
        [entry.desc ? t(entry.desc) : "", t(SECTION_TITLE_KEYS[entry.section]), entry.keywords ?? ""].join(" "),
      );
      if (!terms.every((term) => label.includes(term) || rest.includes(term))) continue;
      const score = terms.reduce((n, term) => n + (label.includes(term) ? 2 : 0), 0);
      scored.push({ entry, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, language]);

  function openResult(entry: SettingEntry) {
    goToSetting(entry.section, entry.id);
    setQuery("");
  }

  return (
    <div className="settings-nav">
      <div className="settings-nav-search">
        <svg className="settings-nav-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </svg>
        <input
          type="text"
          className="settings-nav-search-input"
          value={query}
          placeholder={t("settings.search.placeholder")}
          aria-label={t("settings.search.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            else if (e.key === "Enter" && results[0]) openResult(results[0]);
          }}
        />
        {query && (
          <button type="button" className="settings-nav-search-clear" aria-label={t("settings.search.clear")} onClick={() => setQuery("")}>
            ×
          </button>
        )}
      </div>

      {terms.length > 0 ? (
        <div className="settings-nav-list">
          {results.length === 0 ? (
            <p className="settings-nav-empty">{t("settings.search.empty", { query: query.trim() })}</p>
          ) : (
            results.map((entry) => (
              <button key={entry.id} type="button" className="settings-nav-result" onClick={() => openResult(entry)}>
                <span className="settings-nav-result-label">{t(entry.label)}</span>
                {entry.desc && <span className="settings-nav-result-desc">{t(entry.desc)}</span>}
                <span className="settings-nav-result-section">{t(SECTION_TITLE_KEYS[entry.section])}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="settings-nav-list">
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className={"settings-nav-item" + (section === id ? " is-active" : "")}
              onClick={() => setSection(id)}
            >
              <span className="settings-nav-item-title">{t(SECTION_TITLE_KEYS[id])}</span>
              <span className="settings-nav-item-desc">{t(SECTION_SHORT_KEYS[id])}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
