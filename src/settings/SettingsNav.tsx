import { useSettingsSection, type SettingsSection } from "./SettingsSectionContext";
import "./settings-nav.css";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "generale", label: "Generali" },
  { id: "funzionalita", label: "Funzionalità" },
  { id: "info", label: "Info" },
];

export function SettingsNav() {
  const { section, setSection } = useSettingsSection();

  return (
    <div className="settings-nav">
      <div className="settings-nav-header">Impostazioni</div>
      <div className="settings-nav-list">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={"settings-nav-item" + (section === s.id ? " is-active" : "")}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
