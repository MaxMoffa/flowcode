import { useSettingsSection, type SettingsSection } from "./SettingsSectionContext";
import { useI18n, type MessageKey } from "../i18n";
import "./settings-nav.css";

export const SECTION_TITLE_KEYS: Record<SettingsSection, MessageKey> = {
  generale: "settings.section.general",
  terminale: "settings.section.terminal",
  funzionalita: "settings.section.features",
  info: "settings.section.info",
};

const SECTIONS = Object.keys(SECTION_TITLE_KEYS) as SettingsSection[];

export function SettingsNav() {
  const { t } = useI18n();
  const { section, setSection } = useSettingsSection();

  return (
    <div className="settings-nav">
      <div className="settings-nav-header">{t("settings.title")}</div>
      <div className="settings-nav-list">
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            className={"settings-nav-item" + (section === id ? " is-active" : "")}
            onClick={() => setSection(id)}
          >
            {t(SECTION_TITLE_KEYS[id])}
          </button>
        ))}
      </div>
    </div>
  );
}
